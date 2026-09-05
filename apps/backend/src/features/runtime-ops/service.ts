// Phase 5/6: Agent Run is the ONLY Product execution identity and terminal
// authority. The legacy span/attempt/control-plane audit tables are deleted;
// the Ops API exposes only surface health. Run execution state lives under
// /api/agent-runs (see features/agent-run/http.ts).

import { readdirSync, readFileSync, statSync } from "node:fs";
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
  /** Backend sqlite path — sized for the system-metrics endpoint. */
  dbPath?: string;
}) {
  const { opsStore, getAgentName } = deps;
  const resolveName = (agentId: string) => getAgentName?.(agentId) ?? agentId;

  return {
    /** Live server + subprocess metrics for the observability page. */
    getSystemMetrics(): {
      uptimeSec: number;
      rssMb: number;
      heapMb: number;
      dbSizeBytes: number | null;
      subprocesses: Array<{ pid: number; cmd: string; rssKb: number; cpuSec: number }>;
    } {
      const mem = process.memoryUsage();
      let dbSizeBytes: number | null = null;
      if (deps.dbPath) {
        try {
          dbSizeBytes = statSync(deps.dbPath).size;
        } catch {
          dbSizeBytes = null;
        }
      }
      // Direct children of this process — the spawned agent-run subprocesses.
      const subprocesses: Array<{ pid: number; cmd: string; rssKb: number; cpuSec: number }> = [];
      try {
        const myPid = process.pid;
        const clkTck = 100; // standard Linux USER_HZ
        for (const name of readdirSync("/proc")) {
          if (!/^\d+$/.test(name)) continue;
          const pid = Number(name);
          if (pid === myPid) continue;
          let stat = "";
          let cmdline = "";
          try {
            stat = readFileSync(`/proc/${name}/stat`, "utf8");
            cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8")
              .replaceAll("\u0000", " ")
              .trim();
          } catch {
            continue; // process exited between readdir and read
          }
          // ppid is field 4 — but comm may contain spaces, so slice after the last ')'
          const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          const ppid = Number(after[1]);
          if (ppid !== myPid) continue;
          const rssPages = Number(after[21]);
          const utime = Number(after[11]);
          const stime = Number(after[12]);
          subprocesses.push({
            pid,
            cmd: cmdline.slice(0, 120),
            rssKb: Math.round((rssPages * 4096) / 1024),
            cpuSec: Math.round(((utime + stime) / clkTck) * 10) / 10,
          });
        }
      } catch {
        /* /proc unavailable (non-Linux) — report empty */
      }
      return {
        uptimeSec: Math.round(process.uptime()),
        rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
        heapMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
        dbSizeBytes,
        subprocesses,
      };
    },

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

    appendRunEvent(runId: string, type: string, data: Record<string, unknown>): void {
      opsStore.appendRunEvent(runId, type, data);
    },

    listRunEvents(runId: string, limit?: number) {
      return opsStore.listRunEvents(runId, limit);
    },

    telemetrySummary(since?: number) {
      return opsStore.telemetrySummary(since);
    },
  };
}

export type RuntimeOpsService = ReturnType<typeof createRuntimeOpsService>;
