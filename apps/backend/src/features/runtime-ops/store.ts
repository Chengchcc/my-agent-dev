import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import { surfaceHealthSelectSchema } from "../../infra/db/schema.js";
import type { SurfaceHealthRow } from "./types.js";

function modelIdFromRef(ref: string): string {
  const parsed: unknown = JSON.parse(ref);
  if (
    parsed != null &&
    typeof parsed === "object" &&
    "modelId" in parsed &&
    typeof parsed.modelId === "string"
  ) {
    return parsed.modelId;
  }
  return ref;
}

function errorFromOutcome(outcome: unknown): string | null {
  if (
    outcome != null &&
    typeof outcome === "object" &&
    "error" in outcome &&
    typeof outcome.error === "string"
  ) {
    return outcome.error;
  }
  return null;
}

function failureCause(error: string | null, status: string): string {
  const text = `${status} ${error ?? ""}`.toLowerCase();
  if (
    status === "timeout" ||
    text.includes("timeout") ||
    text.includes("max steps") ||
    text.includes("stale")
  ) {
    return "timeout";
  }
  if (
    text.includes("schema") ||
    text.includes("validation") ||
    text.includes("invalid json") ||
    text.includes("json.parse")
  ) {
    return "schema";
  }
  if (
    text.includes("permission") ||
    text.includes("denied") ||
    text.includes("forbidden") ||
    text.includes("not allowed")
  ) {
    return "permission";
  }
  if (
    text.includes("network") ||
    text.includes("connection") ||
    text.includes("fetch failed") ||
    text.includes("enotfound")
  ) {
    return "network";
  }
  return "other";
}

/** Surface-health audit store (Lark heartbeats). Run execution state lives in
 *  the agent-run feature — Agent Run is the sole execution identity. */
export class RuntimeOpsStore {
  #d: ReturnType<typeof drizzle<typeof schema>>;
  #db: Database;

  constructor(db: Database) {
    this.#d = drizzle(db, { schema, casing: "snake_case" });
    this.#db = db;
  }

  // ─── surface_health ───

  upsertSurfaceHealth(input: {
    agentId: string;
    surface: string;
    status: string;
    payload: Record<string, unknown>;
    lastError?: string;
  }): void {
    const now = Date.now();
    this.#d
      .insert(schema.surfaceHealth)
      .values({
        agentId: input.agentId,
        surface: input.surface,
        status: input.status,
        lastSeenAt: now,
        payload: JSON.stringify(input.payload),
        lastError: input.lastError ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.surfaceHealth.agentId, schema.surfaceHealth.surface],
        set: {
          status: input.status,
          lastSeenAt: now,
          payload: JSON.stringify(input.payload),
          lastError: input.lastError ?? null,
          updatedAt: now,
        },
      })
      .run();
  }

  getSurfaceHealth(agentId: string, surface: string): SurfaceHealthRow | undefined {
    const row = this.#d
      .select()
      .from(schema.surfaceHealth)
      .where(
        and(eq(schema.surfaceHealth.agentId, agentId), eq(schema.surfaceHealth.surface, surface)),
      )
      .get();
    return row ? surfaceHealthSelectSchema.parse(row) : undefined;
  }

  getSurfaceHealthsForAgent(agentId: string): SurfaceHealthRow[] {
    return this.#d
      .select()
      .from(schema.surfaceHealth)
      .where(eq(schema.surfaceHealth.agentId, agentId))
      .all()
      .map((r) => surfaceHealthSelectSchema.parse(r));
  }

  listSurfaceHealths(): SurfaceHealthRow[] {
    return this.#d
      .select()
      .from(schema.surfaceHealth)
      .orderBy(schema.surfaceHealth.agentId, schema.surfaceHealth.surface)
      .all()
      .map((r) => surfaceHealthSelectSchema.parse(r));
  }

  // ─── agent_run_event (run telemetry) ───

  appendRunEvent(runId: string, type: string, data: Record<string, unknown>): void {
    this.#d
      .insert(schema.agentRunEvent)
      .values({ runId, type, data: JSON.stringify(data), ts: Date.now() })
      .run();
  }

  listRunEvents(
    runId: string,
    limit = 500,
  ): Array<{
    seq: number;
    type: string;
    data: Record<string, unknown>;
    ts: number;
  }> {
    return this.#d
      .select()
      .from(schema.agentRunEvent)
      .where(eq(schema.agentRunEvent.runId, runId))
      .orderBy(schema.agentRunEvent.seq)
      .limit(limit)
      .all()
      .map((r) => ({
        seq: r.seq,
        type: r.type,
        data: JSON.parse(r.data) as Record<string, unknown>,
        ts: r.ts,
      }));
  }

  /** Aggregate run telemetry since `sinceMs` (default 24h): totals +
   *  per-run rows for the /system Telemetry card. */
  telemetrySummary(sinceMs?: number): {
    since: number;
    runs: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    toolCalls: number;
    avgDurationMs: number;
    recent: Array<{
      runId: string;
      status: string;
      modelId: string;
      createdAt: number;
      durationMs: number | null;
      toolCalls: number;
      inputTokens: number;
      outputTokens: number;
    }>;
    byAgent: Array<{
      agentId: string;
      runs: number;
      completed: number;
      failed: number;
      successRate: number | null;
    }>;
    failures: Array<{
      runId: string;
      agentId: string;
      status: string;
      modelId: string;
      createdAt: number;
      durationMs: number | null;
      inputTokens: number;
      outputTokens: number;
      error: string | null;
    }>;
    costByHour: Array<{
      hour: number;
      costUsd: number;
      tokens: number;
    }>;
    byModel: Array<{
      modelId: string;
      runs: number;
      completed: number;
      failed: number;
      costUsd: number;
      tokens: number;
    }>;
    successRateByDay: Array<{
      dayStart: number;
      runs: number;
      completed: number;
      failed: number;
      successRate: number | null;
    }>;
    durationByDay: Array<{
      dayStart: number;
      runs: number;
      avgDurationMs: number | null;
    }>;
    failureCauses: Array<{
      cause: string;
      count: number;
    }>;
  } {
    const since = sinceMs ?? Date.now() - 86_400_000;
    const totals = this.#db
      .query(
        `SELECT COUNT(*) AS runs,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.inputTokens') AS REAL)), 0) AS inputTokens,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.outputTokens') AS REAL)), 0) AS outputTokens,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.costUsd') AS REAL)), 0) AS costUsd,
                COALESCE(SUM((
                  SELECT COUNT(*) FROM agent_run_event e
                   WHERE e.run_id = ar.run_id
                     AND e.type IN ('native_tool_started','product_tool_started')
                )), 0) AS toolCalls,
                AVG(CASE WHEN ar.terminal_at IS NOT NULL THEN ar.terminal_at - ar.created_at END) AS avgDurationMs
           FROM agent_run ar
          WHERE ar.created_at >= ?`,
      )
      .get(since) as {
      runs: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      toolCalls: number;
      avgDurationMs: number | null;
    };

    const byAgent = this.#db
      .query(
        `SELECT ar.agent_id AS agentId,
                COUNT(*) AS runs,
                COALESCE(SUM(CASE WHEN ar.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
                COALESCE(SUM(CASE WHEN ar.status IN ('failed','aborted','timeout') THEN 1 ELSE 0 END), 0) AS failed
           FROM agent_run ar
          WHERE ar.created_at >= ?
          GROUP BY ar.agent_id
          ORDER BY failed DESC, runs DESC`,
      )
      .all(since) as Array<{
      agentId: string;
      runs: number;
      completed: number;
      failed: number;
    }>;

    const failures = this.#db
      .query(
        `SELECT ar.run_id AS runId,
                ar.agent_id AS agentId,
                ar.status,
                ar.model_ref AS modelRef,
                ar.created_at AS createdAt,
                ar.terminal_at AS terminalAt,
                ar.terminal_result AS terminalResult,
                COALESCE(CAST(json_extract(ar.terminal_result, '$.usage.inputTokens') AS REAL), 0) AS inputTokens,
                COALESCE(CAST(json_extract(ar.terminal_result, '$.usage.outputTokens') AS REAL), 0) AS outputTokens
           FROM agent_run ar
          WHERE ar.created_at >= ?
            AND ar.status IN ('failed','aborted','timeout')
          ORDER BY ar.created_at DESC
          LIMIT 20`,
      )
      .all(since) as Array<{
      runId: string;
      agentId: string;
      status: string;
      modelRef: string;
      createdAt: number;
      terminalAt: number | null;
      terminalResult: string | null;
      inputTokens: number;
      outputTokens: number;
    }>;

    const costByHour = this.#db
      .query(
        `SELECT (ar.created_at / 3600000) * 3600000 AS hourStart,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.costUsd') AS REAL)), 0) AS costUsd,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.inputTokens') AS REAL)), 0) AS inputTokens,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.outputTokens') AS REAL)), 0) AS outputTokens
           FROM agent_run ar
          WHERE ar.created_at >= ?
          GROUP BY hourStart
          ORDER BY hourStart`,
      )
      .all(since) as Array<{
      hourStart: number;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
    }>;

    const byModel = this.#db
      .query(
        `SELECT ar.model_ref AS modelRef,
                COUNT(*) AS runs,
                COALESCE(SUM(CASE WHEN ar.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
                COALESCE(SUM(CASE WHEN ar.status IN ('failed','aborted','timeout') THEN 1 ELSE 0 END), 0) AS failed,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.costUsd') AS REAL)), 0) AS costUsd,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.inputTokens') AS REAL)), 0) AS inputTokens,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.outputTokens') AS REAL)), 0) AS outputTokens
           FROM agent_run ar
          WHERE ar.created_at >= ?
          GROUP BY ar.model_ref
          ORDER BY costUsd DESC`,
      )
      .all(since) as Array<{
      modelRef: string;
      runs: number;
      completed: number;
      failed: number;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
    }>;

    const since7 = Date.now() - 7 * 86_400_000;
    const successRateByDay = this.#db
      .query(
        `SELECT (ar.created_at / 86400000) * 86400000 AS dayStart,
                COUNT(*) AS runs,
                COALESCE(SUM(CASE WHEN ar.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
                COALESCE(SUM(CASE WHEN ar.status IN ('failed','aborted','timeout') THEN 1 ELSE 0 END), 0) AS failed
           FROM agent_run ar
          WHERE ar.created_at >= ?
          GROUP BY dayStart
          ORDER BY dayStart`,
      )
      .all(since7) as Array<{
      dayStart: number;
      runs: number;
      completed: number;
      failed: number;
    }>;

    const durationByDay = this.#db
      .query(
        `SELECT (ar.created_at / 86400000) * 86400000 AS dayStart,
                COUNT(*) AS runs,
                AVG(CASE WHEN ar.terminal_at IS NOT NULL THEN ar.terminal_at - ar.created_at END) AS avgDurationMs
           FROM agent_run ar
          WHERE ar.created_at >= ?
          GROUP BY dayStart
          ORDER BY dayStart`,
      )
      .all(since7) as Array<{
      dayStart: number;
      runs: number;
      avgDurationMs: number | null;
    }>;

    const failureCauses = (() => {
      const rows = this.#db
        .query(
          `SELECT ar.status, ar.terminal_result AS terminalResult
             FROM agent_run ar
            WHERE ar.created_at >= ?
              AND ar.status IN ('failed','aborted','timeout')`,
        )
        .all(since) as Array<{ status: string; terminalResult: string | null }>;
      const counts: Record<string, number> = {};
      for (const row of rows) {
        const outcome: unknown = row.terminalResult ? JSON.parse(row.terminalResult) : null;
        const cause = failureCause(errorFromOutcome(outcome), row.status);
        counts[cause] = (counts[cause] ?? 0) + 1;
      }
      return Object.entries(counts)
        .map(([cause, count]) => ({ cause, count }))
        .sort((a, b) => b.count - a.count);
    })();

    const recent = this.#db
      .query(
        `SELECT ar.run_id AS runId,
                ar.status,
                ar.model_ref AS modelRef,
                ar.created_at AS createdAt,
                ar.terminal_at AS terminalAt,
                COUNT(CASE WHEN e.type IN ('native_tool_started','product_tool_started') THEN 1 END) AS toolCalls,
                COALESCE(CAST(json_extract(ar.terminal_result, '$.usage.inputTokens') AS REAL), 0) AS inputTokens,
                COALESCE(CAST(json_extract(ar.terminal_result, '$.usage.outputTokens') AS REAL), 0) AS outputTokens
           FROM agent_run ar
           LEFT JOIN agent_run_event e ON e.run_id = ar.run_id
          WHERE ar.created_at >= ?
          GROUP BY ar.run_id
          ORDER BY ar.created_at DESC
          LIMIT 50`,
      )
      .all(since) as Array<{
      runId: string;
      status: string;
      modelRef: string;
      createdAt: number;
      terminalAt: number | null;
      toolCalls: number;
      inputTokens: number;
      outputTokens: number;
    }>;

    return {
      since,
      runs: totals.runs,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costUsd: totals.costUsd,
      toolCalls: totals.toolCalls,
      avgDurationMs: totals.avgDurationMs ?? 0,
      byAgent: byAgent.map((b) => {
        const terminal = b.completed + b.failed;
        return {
          agentId: b.agentId,
          runs: Number(b.runs),
          completed: Number(b.completed),
          failed: Number(b.failed),
          successRate: terminal > 0 ? Number(b.completed) / terminal : null,
        };
      }),
      failures: failures.map((f) => {
        const outcome: unknown = f.terminalResult ? JSON.parse(f.terminalResult) : null;
        return {
          runId: f.runId,
          agentId: f.agentId,
          status: f.status,
          modelId: modelIdFromRef(f.modelRef),
          createdAt: f.createdAt,
          durationMs: f.terminalAt != null ? f.terminalAt - f.createdAt : null,
          inputTokens: Number(f.inputTokens ?? 0),
          outputTokens: Number(f.outputTokens ?? 0),
          error: errorFromOutcome(outcome),
        };
      }),
      costByHour: costByHour.map((h) => ({
        hour: Number(h.hourStart),
        costUsd: Number(h.costUsd),
        tokens: Number(h.inputTokens ?? 0) + Number(h.outputTokens ?? 0),
      })),
      byModel: byModel.map((m) => ({
        modelId: modelIdFromRef(m.modelRef),
        runs: Number(m.runs),
        completed: Number(m.completed),
        failed: Number(m.failed),
        costUsd: Number(m.costUsd),
        tokens: Number(m.inputTokens ?? 0) + Number(m.outputTokens ?? 0),
      })),
      successRateByDay: successRateByDay.map((d) => {
        const terminal = d.completed + d.failed;
        return {
          dayStart: Number(d.dayStart),
          runs: Number(d.runs),
          completed: Number(d.completed),
          failed: Number(d.failed),
          successRate: terminal > 0 ? Number(d.completed) / terminal : null,
        };
      }),
      durationByDay: durationByDay.map((d) => ({
        dayStart: Number(d.dayStart),
        runs: Number(d.runs),
        avgDurationMs: d.avgDurationMs != null ? Number(d.avgDurationMs) : null,
      })),
      failureCauses,
      recent: recent.map((r) => ({
        runId: r.runId,
        status: r.status,
        modelId: modelIdFromRef(r.modelRef),
        createdAt: r.createdAt,
        durationMs: r.terminalAt != null ? r.terminalAt - r.createdAt : null,
        toolCalls: Number(r.toolCalls ?? 0),
        inputTokens: Number(r.inputTokens ?? 0),
        outputTokens: Number(r.outputTokens ?? 0),
      })),
    };
  }
}
