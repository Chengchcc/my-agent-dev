// Execution facts sourced from checkpointer.db
// RunnerRegistry removed — Agent runs in-process
// heartbeat/transport removed — Agent runs in-process, no runner daemon

import type { SpanSupervisor } from "../span/supervisor.js";
import type { CheckpointEventsStore } from "./checkpoint-events-store.js";
import type { InsightsSummary, RunInsights } from "./insights.js";
import { getInsightsSummary, getRunInsights } from "./insights.js";
import { buildRunQuery } from "./span-query-service.js";
import type { RuntimeOpsStore } from "./store.js";
import type { ControlPlaneEvent } from "./types.js";

export interface RunOpsListItem {
  spanId: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  kind: string;
  parentSpanId: string | null;
  status: string;
  traceId: string | null;
  startedAt: number;
  endedAt: number | null;
  latestAttemptSeq: number | null;
  lastEventType: string | null;
  lastOpsEventKind: string | null;
}

export interface RunOpsDetail {
  run: {
    spanId: string;
    sessionId: string;
    agentId: string;
    agentName: string;
    kind: string;
    parentSpanId: string | null;
    status: string;
    traceId: string | null;
    startedAt: number;
    endedAt: number | null;
  };
  attempts: Array<{
    attemptSeq: number;
    startedAt: number;
    endedAt: number | null;
  }>;
  eventLog: {
    lastSeq: number | null;
    lastEventType: string | null;
    lastEventAt: number | null;
  };
  ops: Pick<ControlPlaneEvent, "seq" | "kind" | "payload" | "traceId" | "ts">[];
}

export interface AgentRuntimeStatus {
  agentId: string;
  agentName: string;
  surfaces: Record<
    string,
    {
      status: string;
      lastSeenAt: number | null;
      lastError: string | null;
      counters: Record<string, number>;
    }
  >;
}

export type CancelRunResult =
  | { ok: true; state: "abort_sent"; spanId: string; attemptSeq: number }
  | { ok: true; state: "already_terminal"; spanId: string; status: string }
  | { ok: false; error: "not_found" };

export type RecoverRunResult =
  | { state: "already_terminal"; status: string }
  | { state: "marked_interrupted"; reason: "heartbeat_timeout" }
  | { state: "waiting"; reason: "session_not_found" };

export function createRuntimeOpsService(deps: {
  opsStore: RuntimeOpsStore;
  supervisor: SpanSupervisor;
  checkpointEventsStore?: CheckpointEventsStore;
  /** M16.2: Resolve agent display name for ops DTOs. Falls back to agentId if absent. */
  getAgentName?: (agentId: string) => string | undefined;
}) {
  const { opsStore, supervisor, checkpointEventsStore, getAgentName } = deps;
  const resolveName = (agentId: string) => getAgentName?.(agentId) ?? agentId;

  return {
    listRuns(params: {
      agentId?: string;
      sessionId?: string;
      conversationId?: string;
      status?: string;
      limit?: number;
      traceId?: string;
    }): RunOpsListItem[] {
      const raw = params.limit ?? 50;
      const limit = Number.isFinite(raw) && raw > 0 && raw <= 500 ? Math.floor(raw) : 50;
      const { sql, args } = buildRunQuery(
        {
          agentId: params.agentId,
          sessionId: params.sessionId,
          conversationId: params.conversationId,
          status: params.status,
        },
        limit,
      );

      const rows = opsStore
        .getRawDb()
        .query(sql)
        .all(...args) as Array<{
        span_id: string;
        session_id: string;
        agent_id: string;
        kind: string;
        parent_span_id: string | null;
        status: string;
        started_at: number;
        ended_at: number | null;
      }>;

      let items = rows.map((r) => {
        const attempt = opsStore.getLatestAttempt(r.span_id);

        const factEvents = checkpointEventsStore?.readBySpan(r.session_id, r.span_id) ?? [];
        const lastFact = factEvents.at(-1);

        const lastOps = opsStore.getControlPlaneEvents(r.span_id).pop();

        opsStore.getSpanOrigin(r.span_id);

        return {
          spanId: r.span_id,
          sessionId: r.session_id,
          agentId: r.agent_id,
          agentName: resolveName(r.agent_id),
          kind: r.kind,
          parentSpanId: r.parent_span_id,
          status: r.status,
          traceId: null, // deprecated — use spanId
          startedAt: r.started_at,
          endedAt: r.ended_at,
          latestAttemptSeq: attempt?.seq ?? null,
          lastEventType: lastFact?.type ?? null,
          lastOpsEventKind: lastOps?.kind ?? null,
        };
      });

      if (params.traceId) {
        items = items.filter((i) => i.traceId === params.traceId);
      }
      return items;
    },

    getRunDetail(spanId: string): RunOpsDetail | null {
      const run = opsStore.getRunBySpanId(spanId);
      if (!run) return null;

      opsStore.getSpanOrigin(spanId);

      const attempts = opsStore.getAttemptsBySpanId(spanId);

      const sessionId = run.sessionId;
      const factEvents = checkpointEventsStore?.readBySpan(sessionId, spanId) ?? [];
      const lastFact = factEvents.at(-1);

      const ops = opsStore.getControlPlaneEvents(spanId);

      return {
        run: {
          spanId: run.spanId,
          sessionId: run.sessionId,
          agentId: run.agentId,
          agentName: resolveName(run.agentId),
          kind: run.kind,
          parentSpanId: run.parentSpanId,
          status: run.status,
          traceId: null, // deprecated — use spanId
          startedAt: run.startedAt,
          endedAt: run.endedAt,
        },
        attempts: attempts.map((a) => ({
          attemptSeq: a.seq,
          startedAt: a.startedAt,
          endedAt: a.endedAt,
        })),
        eventLog: {
          lastSeq: null,
          lastEventType: lastFact?.type ?? null,
          lastEventAt: lastFact?.ts ?? null,
        },
        ops: ops.map((e) => ({
          seq: e.seq,
          kind: e.kind,
          payload: e.payload,
          traceId: e.traceId,
          ts: e.ts,
        })),
      };
    },

    cancel(spanId: string): CancelRunResult {
      const run = opsStore.getRunBySpanId(spanId);
      if (!run) return { ok: false, error: "not_found" };

      if (run.status !== "running") {
        return { ok: true, state: "already_terminal", spanId, status: run.status };
      }

      const cancelled = supervisor.cancel(spanId);
      if (!cancelled) return { ok: false, error: "not_found" };

      return {
        ok: true,
        state: "abort_sent",
        spanId,
        attemptSeq: 1,
      };
    },

    async recover(spanId: string): Promise<RecoverRunResult> {
      const run = opsStore.getRunBySpanId(spanId);
      if (!run) return { state: "already_terminal", status: "not_found" };
      if (run.status !== "running") return { state: "already_terminal", status: run.status };

      const session = supervisor.getActive().get(spanId);
      if (!session) {
        await supervisor.notifyRunComplete(run.sessionId, spanId, "interrupted", run.kind);
        return { state: "marked_interrupted", reason: "heartbeat_timeout" };
      }

      return { state: "waiting", reason: "session_not_found" };
    },

    getAgentRuntime(agentId: string): AgentRuntimeStatus {
      const surfaces = opsStore.getSurfaceHealthsForAgent(agentId);
      const result: AgentRuntimeStatus["surfaces"] = {};
      for (const sh of surfaces) {
        const raw = sh.payload; // Already parsed by Zod transform
        const flatten = (obj: Record<string, unknown>, prefix: string) => {
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === "number") result[sh.surface]!.counters[`${prefix}${k}`] = v;
          }
        };
        result[sh.surface] = {
          status: sh.status,
          lastSeenAt: sh.lastSeenAt,
          lastError: sh.lastError ?? null,
          counters: {},
        };
        flatten(raw, "");
      }
      return { agentId, agentName: resolveName(agentId), surfaces: result };
    },

    getTraceDetail(
      traceId: string,
    ): { origins: { spanId: string; traceId: string }[]; events: ControlPlaneEvent[] } | null {
      const origins = opsStore.listSpanOrigins(); // traceId deprecated — return all
      if (origins.length === 0) {
        const opsEvents = opsStore.getControlPlaneEventsByTrace(traceId);
        if (opsEvents.length === 0) return null;
      }
      const events = opsStore.getControlPlaneEventsByTrace(traceId);
      return { origins: origins.map((o) => ({ spanId: o.spanId, traceId: "" })), events };
    },

    listSurfaces(): Array<{
      agentId: string;
      agentName: string;
      surface: string;
      status: string;
      lastSeenAt: number | null;
      lastError: string | null;
      counters: Record<string, number>;
    }> {
      return opsStore.listSurfaceHealths().map((sh) => {
        const counters: Record<string, number> = {};
        const payload = sh.payload as Record<string, unknown>;
        for (const [k, v] of Object.entries(payload)) {
          if (typeof v === "number") counters[k] = v;
        }
        return {
          agentId: sh.agentId,
          agentName: resolveName(sh.agentId),
          surface: sh.surface,
          status: sh.status,
          lastSeenAt: sh.lastSeenAt,
          lastError: sh.lastError,
          counters,
        };
      });
    },

    async getRunInsights(spanId: string): Promise<RunInsights | null> {
      const run = opsStore.getRunBySpanId(spanId);
      if (!run) return null;

      return getRunInsights(
        { checkpointEventsStore, getAgentName },
        {
          spanId: run.spanId,
          sessionId: run.sessionId,
          agentId: run.agentId,
          status: run.status,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
        },
      );
    },

    async getInsightsSummary(range: { from: number; to: number }): Promise<InsightsSummary> {
      const runRows = opsStore
        .getRawDb()
        .query(
          "SELECT span_id, agent_id FROM run WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) LIMIT 500",
        )
        .all(range.to, range.from) as Array<{ span_id: string; agent_id: string }>;

      const runAgentMap = new Map<string, string>();
      for (const r of runRows) runAgentMap.set(r.span_id, r.agent_id);

      return getInsightsSummary({ checkpointEventsStore, getAgentName, runAgentMap }, range);
    },

    // ── Session-level aggregation (B2: /ops/sessions) ──────────

    listSessions(params: { agentId?: string; status?: string; limit?: number }): Array<{
      sessionId: string;
      agentId: string;
      spanCount: number;
      lastSpanAt: number | null;
      status: "running" | "done";
    }> {
      const limit =
        Number.isFinite(params.limit) && (params.limit ?? 0) > 0 ? Math.floor(params.limit!) : 100;
      const whereConditions: string[] = [];
      const havingConditions: string[] = [];
      const bindings: (string | number)[] = [];
      if (params.agentId) {
        whereConditions.push("agent_id = ?");
        bindings.push(params.agentId);
      }
      if (params.status === "running") {
        // Filter after aggregation: only sessions that have at least one running span
        havingConditions.push("MAX(CASE WHEN status = 'running' THEN 1 ELSE 0 END) = 1");
      } else if (params.status === "done") {
        // Filter after aggregation: only sessions where all spans are done (no running)
        havingConditions.push("MAX(CASE WHEN status = 'running' THEN 1 ELSE 0 END) = 0");
      }
      const where = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";
      const having = havingConditions.length > 0 ? `HAVING ${havingConditions.join(" AND ")}` : "";
      const rows = opsStore
        .getRawDb()
        .query(
          `SELECT session_id, MAX(started_at) AS last_span_at, COUNT(*) AS span_count,
                  MAX(agent_id) AS agent_id
             FROM run ${where}
            GROUP BY session_id
            ${having}
            ORDER BY last_span_at DESC
            LIMIT ?`,
        )
        .all(...bindings, limit) as Array<{
        session_id: string;
        last_span_at: number | null;
        span_count: number;
        agent_id: string;
      }>;
      return rows.map((r) => {
        const running = opsStore
          .getRawDb()
          .query("SELECT 1 FROM run WHERE session_id = ? AND status = 'running' LIMIT 1")
          .get(r.session_id);
        return {
          sessionId: r.session_id,
          agentId: r.agent_id,
          spanCount: r.span_count,
          lastSpanAt: r.last_span_at,
          status: running ? ("running" as const) : ("done" as const),
        };
      });
    },

    getSessionDetail(sessionId: string): {
      sessionId: string;
      agentId: string;
      status: "running" | "done";
      spanCount: number;
      spans: Array<{
        spanId: string;
        status: string;
        kind: string;
        agentId: string;
        startedAt: number | null;
        endedAt: number | null;
      }>;
    } | null {
      const spans = opsStore.getSpansBySession(sessionId);
      if (spans.length === 0) return null;
      return {
        sessionId,
        agentId: spans[0]!.agentId,
        status: spans.some((s) => s.status === "running")
          ? ("running" as const)
          : ("done" as const),
        spanCount: spans.length,
        spans,
      };
    },

    ingestLarkHeartbeat(body: {
      agentId: string;
      status: string;
      payload?: Record<string, unknown>;
      lastError?: string;
    }): void {
      opsStore.upsertSurfaceHealth({
        agentId: body.agentId,
        surface: "lark",
        status: body.status,
        payload: body.payload ?? {},
        lastError: body.lastError,
      });
    },
  };
}

export type RuntimeOpsService = ReturnType<typeof createRuntimeOpsService>;
