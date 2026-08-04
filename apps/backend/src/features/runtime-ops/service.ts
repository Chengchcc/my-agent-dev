// Phase 5: Agent Run is the ONLY Product execution identity and terminal
// authority. Spans/attempts/control-plane rows remain as audit data but
// never decide run state; the session/run/recover/insights Ops APIs are
// replaced by /api/agent-runs (see features/agent-run/http.ts).

import type { RuntimeOpsStore } from "./store.js";

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

export function createRuntimeOpsService(deps: {
  opsStore: RuntimeOpsStore;
  /** M16.2: Resolve agent display name for ops DTOs. Falls back to agentId if absent. */
  getAgentName?: (agentId: string) => string | undefined;
}) {
  const { opsStore, getAgentName } = deps;
  const resolveName = (agentId: string) => getAgentName?.(agentId) ?? agentId;

  return {
    /** Surface health is audit/monitoring state (Lark heartbeats), not run
     *  execution state. */
    getAgentRuntime(agentId: string): AgentRuntimeStatus {
      const surfaces = opsStore.getSurfaceHealthsForAgent(agentId);
      const result: AgentRuntimeStatus["surfaces"] = {};
      for (const sh of surfaces) {
        const raw = sh.payload as Record<string, unknown>;
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
