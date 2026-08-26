import type { Database } from "bun:sqlite";
import type { BackendRunOutcome } from "@chengchenccc/agent-contract";
import { resolveModelAlias } from "@chengchenccc/ai";
import { Elysia, t } from "elysia";
import { sseResponse } from "../../http/response.js";
import { type AgentRunExecutionService, runEventStreamFor } from "./execution.js";
import type { AgentRunService } from "./service.js";

const ACTIVE_STATUSES = ["running", "waiting", "commit_failed"];
const TERMINAL_STATUSES = ["completed", "failed", "aborted", "timeout"];

/** Tool-result gate (P2): the model's own PASS/FAIL text is not trusted.
 *  Verdict comes from tool_result.is_error flags in the committed run. */
function deriveVerdict(outcome: BackendRunOutcome | null): "pass" | "fail" | "unknown" {
  if (outcome?.status !== "completed") return "unknown";
  for (const message of outcome.messages ?? []) {
    for (const block of message.blocks ?? []) {
      if (block.type === "tool_result" && block.is_error) return "fail";
    }
  }
  return "pass";
}

/** Minimal Agent Run Ops API: Agent Run is the only Product execution
 *  identity. Spans/attempts/checkpoint events remain audit-only. */
export function agentRunRoutes(input: {
  db: Database;
  agentRunService: AgentRunService;
  agentRunExecution: AgentRunExecutionService;
  /** Catalog prices keyed "<backendKind>/<modelId>", USD per million tokens.
   *  Boot builds it once; catalogs are static for the process lifetime. */
  modelCosts: Promise<
    Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
  >;
}) {
  const { db, agentRunService, agentRunExecution, modelCosts } = input;

  type UsageTotals = {
    runs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  };

  /** Token sums per model_ref, priced via the catalog. Falls back to the
   *  backend-reported usage.costUsd when a model has no catalog price. */
  async function usageTotals(where: string, args: (string | number)[]): Promise<UsageTotals> {
    const groups = db
      .query(
        `SELECT ar.model_ref, COUNT(*) AS runs,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.inputTokens') AS REAL)), 0) AS inputTokens,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.outputTokens') AS REAL)), 0) AS outputTokens,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.cacheReadTokens') AS REAL)), 0) AS cacheReadTokens,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.cacheWriteTokens') AS REAL)), 0) AS cacheWriteTokens,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.costUsd') AS REAL)), 0) AS reportedCostUsd
           FROM agent_run ar
          WHERE ar.terminal_result IS NOT NULL ${where}
          GROUP BY ar.model_ref`,
      )
      .all(...args) as Array<{
      model_ref: string;
      runs: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      reportedCostUsd: number;
    }>;

    const costs = await modelCosts;
    const t: UsageTotals = {
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
    for (const g of groups) {
      t.runs += g.runs;
      t.inputTokens += g.inputTokens;
      t.outputTokens += g.outputTokens;
      t.cacheReadTokens += g.cacheReadTokens;
      t.cacheWriteTokens += g.cacheWriteTokens;
      const ref = JSON.parse(g.model_ref) as { backendKind: string; modelId: string };
      const c = costs.get(`${ref.backendKind}/${resolveModelAlias(ref.modelId)}`);
      t.costUsd += c
        ? (g.inputTokens * c.input +
            g.outputTokens * c.output +
            g.cacheReadTokens * c.cacheRead +
            g.cacheWriteTokens * c.cacheWrite) /
          1e6
        : g.reportedCostUsd;
    }
    return t;
  }

  return new Elysia()
    .get(
      "/api/agent-runs",
      ({ query }) => {
        const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 500);
        const where: string[] = [];
        const args: (string | number)[] = [];
        if (query.status) {
          where.push("ar.status = ?");
          args.push(query.status);
        }
        if (query.agentId) {
          where.push("ar.agent_id = ?");
          args.push(query.agentId);
        }
        const sql = `SELECT ar.run_id, ar.conversation_id, ar.agent_id, ar.status,
                            ar.model_ref, ar.created_at, ar.terminal_at, ar.terminal_result
                       FROM agent_run ar
                       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
                       ORDER BY ar.created_at DESC
                       LIMIT ?`;
        const rows = db.query(sql).all(...args, limit) as Array<{
          run_id: string;
          conversation_id: string;
          agent_id: string;
          status: string;
          model_ref: string;
          created_at: number;
          terminal_at: number | null;
          terminal_result: string | null;
        }>;
        return {
          runs: rows.map((r) => {
            const outcome = r.terminal_result
              ? (JSON.parse(r.terminal_result) as BackendRunOutcome)
              : null;
            return {
              runId: r.run_id,
              conversationId: r.conversation_id,
              agentId: r.agent_id,
              status: r.status,
              model: JSON.parse(r.model_ref) as { backendKind: string; modelId: string },
              createdAt: r.created_at,
              terminalAt: r.terminal_at,
              usage: outcome?.usage ?? null,
              verdict: deriveVerdict(outcome),
            };
          }),
        };
      },
      {
        query: t.Object({
          status: t.Optional(
            t.Union([
              t.Literal("running"),
              t.Literal("waiting"),
              t.Literal("commit_failed"),
              t.Literal("completed"),
              t.Literal("failed"),
              t.Literal("aborted"),
              t.Literal("timeout"),
            ]),
          ),
          agentId: t.Optional(t.String()),
          limit: t.Optional(t.String()),
        }),
      },
    )
    .get(
      "/api/usage/summary",
      async ({ query }) => {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        return {
          conversation: query.conversationId
            ? await usageTotals("AND ar.conversation_id = ?", [query.conversationId])
            : null,
          agent: query.agentId ? await usageTotals("AND ar.agent_id = ?", [query.agentId]) : null,
          today: await usageTotals("AND ar.created_at >= ?", [startOfDay.getTime()]),
        };
      },
      {
        query: t.Object({
          conversationId: t.Optional(t.String({ minLength: 1 })),
          agentId: t.Optional(t.String({ minLength: 1 })),
        }),
      },
    )
    .get("/api/agent-runs/:runId", async ({ params: { runId }, set }) => {
      const run = await agentRunService.getRun(runId);
      if (!run) {
        set.status = 404;
        return { error: "Run not found" };
      }
      const inputs = (await agentRunService.listInputs(run.branchId)).filter(
        (i) => i.runId === runId,
      );
      return {
        run: {
          runId: run.runId,
          branchId: run.branchId,
          conversationId: run.conversationId,
          agentId: run.agentId,
          model: run.modelRef,
          status: run.status,
          verdict: deriveVerdict(run.terminalResult),
          configRevision: run.configRevision,
          createdAt: run.createdAt,
          terminalAt: run.terminalAt,
          terminalResult: run.terminalResult,
          usage: run.terminalResult?.usage ?? null,
        },
        inputs: inputs.map((i) => ({
          inputId: i.inputId,
          mode: i.mode,
          status: i.status,
          runId: i.runId,
          createdAt: i.createdAt,
          deliveredAt: i.deliveredAt,
        })),
      };
    })
    .post("/api/agent-runs/:runId/cancel", async ({ params: { runId }, set }) => {
      const run = await agentRunService.getRun(runId);
      if (!run) {
        set.status = 404;
        return { error: "Run not found" };
      }
      if (TERMINAL_STATUSES.includes(run.status)) {
        return { ok: true, state: "already_terminal", runId, status: run.status };
      }
      if (!ACTIVE_STATUSES.includes(run.status)) {
        set.status = 409;
        return { error: `Run ${runId} is ${run.status}` };
      }
      await agentRunExecution.stop(runId);
      return { ok: true, state: "abort_sent", runId };
    })
    .post("/api/agent-runs/:runId/approval", async ({ params: { runId }, body, set }) => {
      const run = await agentRunService.getRun(runId);
      if (!run) {
        set.status = 404;
        return { error: "Run not found" };
      }
      const payload = body as { callId?: unknown; decision?: unknown } | undefined;
      const isTerminal = TERMINAL_STATUSES.includes(run.status);
      const isAllow = payload?.decision === "allow";
      const isDeny = payload?.decision === "deny";
      const hasValidDecision = typeof payload?.callId === "string" && (isAllow || isDeny);
      if (isTerminal) {
        set.status = 409;
        return { error: `Run ${runId} is ${run.status}` };
      }
      if (!hasValidDecision) {
        set.status = 400;
        return { error: "body must be { callId: string, decision: 'allow' | 'deny' }" };
      }
      await agentRunExecution.resolveApproval(
        runId,
        payload.callId as string,
        payload.decision as "allow" | "deny",
      );
      return { ok: true, runId, callId: payload.callId, decision: payload.decision };
    })
    .get("/api/agent-runs/:runId/events", async ({ request, params: { runId } }) => {
      const run = await agentRunService.getRun(runId);
      const stream = runEventStreamFor(run, agentRunExecution, runId, request.signal);
      return sseResponse(
        stream,
        (ev) => ({
          id: runId,
          event: ev.type,
          data: ev,
        }),
        request.signal,
      );
    });
}
