import type { AgentRun } from "../agent-run/domain.js";
import { isTerminalStatus } from "../agent-run/domain.js";
import type { AgentRunExecutionService } from "../agent-run/execution.js";
import type { AgentRunService } from "../agent-run/service.js";
import type { CronJobRow } from "../cron/domain.js";
import type { LoopStateStore } from "./loop-state-store.js";
import { loopGeneratorConversationId } from "./loop-step.js";

/**
 * Loop Doctor: active health check + repair for a Loop's state.
 *
 * Finds and fixes the failure modes that leave a Loop "rotten" instead of
 * failing loudly:
 *  1. zombie_run  — an active Agent Run that lost its live child (child
 *                   crashed, process restarted, cron timed out without
 *                   cancelling). abortStaleRun terminates it and releases
 *                   the branch so the next tick is clean.
 *  2. stale_item  — an item parked in fixing/verifying whose generator Run
 *                   is already terminal. Reset the item (ESCALATE → inbox)
 *                   so it stops pretending it is being worked on.
 *  3. deferred_due — a deferred item whose until/after condition is met but
 *                   no tick has run yet. UNDEFER it.
 *
 * Triggered at startup, on a timer, and manually (POST /api/loops/:id/doctor).
 */

export interface LoopDoctorIssue {
  kind: "zombie_run" | "stale_item" | "deferred_due";
  target: string;
  action: string;
}

export interface LoopDoctorReport {
  loopId: string;
  checkedAt: number;
  issues: LoopDoctorIssue[];
  fixed: string[];
}

export interface LoopDoctorDeps {
  cronSvc: { getById(id: string): CronJobRow | null };
  store: LoopStateStore;
  agentRunService: Pick<AgentRunService, "listActiveRunsForConversations" | "getRun">;
  agentRunExecution: Pick<AgentRunExecutionService, "isLive" | "isInflight" | "abortStaleRun">;
  now?: () => number;
}

export async function runLoopDoctor(
  deps: LoopDoctorDeps,
  loopId: string,
): Promise<LoopDoctorReport> {
  const now = deps.now ?? Date.now;
  const report: LoopDoctorReport = { loopId, checkedAt: now(), issues: [], fixed: [] };
  const job = deps.cronSvc.getById(loopId);
  if (!job?.loopConfigPath) return report;

  // 1. Zombie runs: active in DB but no live child / no in-flight dispatch.
  const conversationId = loopGeneratorConversationId(loopId);
  const activeRuns = await deps.agentRunService.listActiveRunsForConversations([conversationId]);
  for (const run of activeRuns) {
    if (
      !deps.agentRunExecution.isLive(run.runId) &&
      !deps.agentRunExecution.isInflight(run.runId)
    ) {
      report.issues.push({
        kind: "zombie_run",
        target: run.runId,
        action: "abortStaleRun (releases branch)",
      });
      try {
        await deps.agentRunExecution.abortStaleRun(run.runId);
        report.fixed.push(`zombie run ${run.runId}`);
      } catch (err) {
        report.issues.push({
          kind: "zombie_run",
          target: run.runId,
          action: `abort failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // 2+3. Item-level repairs (requires the loop state store).
  const state = deps.store.load(loopId);
  let changed = false;
  for (const item of Object.values(state.items)) {
    if ((item.step === "fixing" || item.step === "verifying") && item.generatorRunId) {
      const run: AgentRun | null = await deps.agentRunService.getRun(item.generatorRunId);
      if (run && isTerminalStatus(run.status)) {
        report.issues.push({
          kind: "stale_item",
          target: item.id,
          action: "ESCALATE to inbox (run already terminal)",
        });
        state.items[item.id] = {
          ...item,
          step: "inbox",
          result: {
            verdict: "ESCALATE",
            reasons: [
              `Loop Doctor: generator run ${run.runId} ended ${run.status} while item was still ${item.step}`,
            ],
            evidence: run.runId,
          },
        };
        changed = true;
        report.fixed.push(`stale item ${item.id}`);
      }
    }
    if (item.defer) {
      const untilDue = item.defer.until != null && item.defer.until <= now();
      const depsMet =
        item.defer.after != null &&
        item.defer.after.length > 0 &&
        !item.defer.after.some((dep) => {
          const d = state.items[dep];
          return d && d.step !== "resolved";
        });
      if (untilDue || depsMet) {
        report.issues.push({
          kind: "deferred_due",
          target: item.id,
          action: "UNDEFER (condition met)",
        });
        state.items[item.id] = { ...item, defer: undefined };
        changed = true;
        report.fixed.push(`deferred item ${item.id}`);
      }
    }
  }
  if (changed) {
    deps.store.save(loopId, state, {});
  }

  return report;
}
