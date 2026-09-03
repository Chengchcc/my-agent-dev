import type { AgentBackend, BackendEvent } from "@chengchenccc/agent-contract";
import { BACKEND_KINDS, debugLog } from "@chengchenccc/agent-contract";
import type { Message } from "@chengchenccc/message";
import type { AgentRun } from "./domain.js";
import { isActiveStatus, isTerminalStatus } from "./domain.js";
import { createExecutionDispatcher } from "./execution-dispatch.js";
import { finalAnswerMessage } from "./execution-input.js";
import { createLiveEventBus } from "./execution-live.js";
import type {
  AgentRunExecutionDeps,
  AgentRunExecutionService,
  LiveRun,
} from "./execution-types.js";

// ─── Execution service ───────────────────────────────────────────────

export type {
  AgentRunExecutionDeps,
  AgentRunExecutionService,
  LiveRun,
} from "./execution-types.js";

/** Late-subscription handling for GET /agent-runs/:runId/events.
 *  - settled/unknown run: one terminal status event, then close (never a
 *    permanently open SSE for a run nothing will close);
 *  - commit_failed: the outcome is stored and the child is gone - report a
 *    terminal status WITHOUT touching the Product Run (retryTerminalCommit
 *    owns it); aborting here would conflict with the stored outcome;
 *  - active + live child OR dispatch in flight (pre-acceptance): subscribe
 *    to transient events - an inflight run must NEVER be aborted;
 *  - active, neither live nor inflight (true zombie): terminalize first,
 *    then a terminal status + close so the UI never shows a permanent
 *    Running state. */
export function runEventStreamFor(
  run: Pick<AgentRun, "status"> | null,
  execution: {
    isLive(runId: string): boolean;
    isInflight(runId: string): boolean;
    abortStaleRun(runId: string): Promise<void>;
    subscribe(runId: string, signal?: AbortSignal): AsyncIterable<BackendEvent>;
  },
  runId: string,
  signal?: AbortSignal,
): AsyncIterable<BackendEvent> {
  const terminal = (status: string): AsyncIterable<BackendEvent> =>
    (async function* () {
      yield { type: "status", status };
    })();
  if (!run) return terminal("failed");
  if (isTerminalStatus(run.status)) return terminal(run.status);
  if (run.status === "commit_failed") return terminal("failed");
  if (execution.isLive(runId) || execution.isInflight(runId)) {
    return execution.subscribe(runId, signal);
  }
  return (async function* () {
    await execution.abortStaleRun(runId);
    yield { type: "status", status: "aborted" };
  })();
}

export function createAgentRunExecutionService(
  deps: AgentRunExecutionDeps,
): AgentRunExecutionService {
  const { runPort, backends } = deps;

  /** Process-lifetime live refs, only for steer/stop/current-event
   *  subscription. Removed when the run reaches a terminal state. */
  const liveRuns = new Map<string, LiveRun>();
  const inflight = new Set<string>();
  /** Dispatch promises by runId: dispose() drains them AFTER the children
   *  are dead so the DB is never closed mid-finalize. */
  const inflightPromises = new Map<string, Promise<void>>();
  const execState = { disposed: false };
  const liveEvents = createLiveEventBus(deps);
  const { dispatchFn, entryFor } = createExecutionDispatcher({
    deps,
    liveEvents,
    liveRuns,
    inflight,
    inflightPromises,
    state: execState,
  });

  return {
    async dispatch(runId) {
      await dispatchFn(runId);
    },

    /** Inject a steer into the LIVE run of a branch. When the run has no
     *  live handle (settled, or on another process after restart) the input
     *  is cancelled and the caller gets an explicit error - a steer is never
     *  replayed as a normal input. */
    async injectSteer(
      branchId: string,
      input: { inputId: string; message: Message },
    ): Promise<void> {
      const active = await runPort.getActiveRun(branchId);
      if (!active) {
        // No active run: the steer cannot be delivered. Explicit conflict -
        // never silently dropped, never converted to a normal input.
        await runPort.cancelInput(input.inputId).catch(() => {});
        throw new Error(`steer rejected: no active run on branch ${branchId}`);
      }
      const live = liveRuns.get(active.runId);
      if (!live) {
        // The run is active in the DB but this process lost its live handle
        // (restart). Live steer cannot cross processes - cancel and report.
        await runPort.cancelInput(input.inputId).catch(() => {});
        throw new Error(`steer rejected: run ${active.runId} has no live loop on this process`);
      }
      const claimed = await runPort.deliverSteerInput(input.inputId, active.runId);
      if (!claimed) return; // already delivering/delivered or gone
      const entry = entryFor(active.modelRef.backendKind);
      if (!entry) {
        await runPort.cancelInput(input.inputId).catch(() => {});
        throw new Error(
          `steer rejected: unknown or unregistered backend kind "${active.modelRef.backendKind}" ` +
            `(known: ${BACKEND_KINDS.join(", ")})`,
        );
      }
      try {
        await (entry.backend as AgentBackend).steer(active.runId, {
          inputId: input.inputId,
          message: input.message,
        });
      } catch (err) {
        // The child rejected the steer (run settled in between): the input
        // must not linger as a phantom delivering row.
        await runPort.cancelInput(input.inputId).catch(() => {});
        throw err;
      }
      await runPort.markInputAccepted(input.inputId);
    },

    /** Startup recovery: redeliver every durable `delivering` input (same
     *  runId/inputId/idempotency - the Backend dedupes), promote every
     *  branch with a pending non-steer input that never became a Run
     *  (crash gap), and surface commit_failed runs for retryTerminalCommit.
     *  Called once at boot. */
    async recover() {
      const delivering = await runPort.listDeliveringInputs();
      for (const claimed of delivering) {
        await dispatchFn(claimed.runId).catch((err) => {
          console.error(`[agent-run] recover dispatch failed for ${claimed.runId}:`, err);
        });
      }
      // Crash gap: pending input with run_id IS NULL on an idle branch. Each
      // branch promotes its oldest input into a fresh Run from the input's
      // OWN snapshot (FIFO); acquireNextRun no-ops on busy branches.
      const idleBranches = await runPort.listIdleBranchesWithPendingInputs();
      for (const branchId of idleBranches) {
        const promoted = await runPort.acquireNextRun(branchId);
        if (!promoted) continue;
        await dispatchFn(promoted.runId).catch((err) => {
          console.error(`[agent-run] recover promote dispatch failed for ${promoted.runId}:`, err);
        });
      }
      const failed = await runPort.listCommitFailedRuns();
      for (const run of failed) {
        await this.retryTerminalCommit(run.runId).catch((err) => {
          console.error(`[agent-run] recover commit retry failed for ${run.runId}:`, err);
        });
      }
      // Restart orphans: a run whose input was DELIVERED (child accepted)
      // has no live child after a restart and cannot be resumed (one-shot
      // child architecture). Terminal it, cancel nothing (already
      // delivered), release the branch, and promote the next queued input.
      const orphans = await runPort.listActiveRunsWithDeliveredInputs();
      for (const orphan of orphans) {
        if (liveRuns.has(orphan.runId)) continue;
        debugLog(
          "agent-run",
          `recover_orphan runId=${orphan.runId} status=${orphan.status} branchId=${orphan.branchId}`,
        );
        await runPort
          .finalizeRun(orphan.runId, {
            status: "aborted",
            error: "stale run without live child after restart",
          })
          .catch((err) => {
            console.error(`[agent-run] recover orphan finalize failed for ${orphan.runId}:`, err);
          });
        const promoted = await runPort.acquireNextRun(orphan.branchId);
        if (!promoted) continue;
        await dispatchFn(promoted.runId).catch((err) => {
          console.error(`[agent-run] recover orphan promote failed for ${promoted.runId}:`, err);
        });
      }
    },

    /** Retry the Product commit of a commit_failed run from the STORED
     *  outcome only - never re-invokes the Backend. */
    async retryTerminalCommit(runId) {
      const run = await runPort.getRun(runId);
      if (run?.status !== "commit_failed" || !run.terminalResult) return;
      const outcome = run.terminalResult;
      if (outcome.status !== "completed") {
        // Non-completed terminal: finalize (idempotent) and release.
        await runPort.finalizeRun(runId, outcome).catch(() => {});
        return;
      }
      const { seqs } = await runPort.commitCompletedRun({
        runId,
        outcome,
        messages: outcome.messages ?? [],
      });
      deps.onRunCommitted?.(runId, finalAnswerMessage(outcome.messages), seqs);
      liveRuns.delete(runId);
      liveEvents.closeSubscribers(runId);
    },
    async resolveApproval(runId, callId, decision) {
      const live = liveRuns.get(runId);
      if (!live) {
        throw new Error(`approval rejected: run ${runId} has no live loop on this process`);
      }
      const run = await runPort.getRun(runId);
      const entry = run ? entryFor(run.modelRef.backendKind) : undefined;
      if (!entry?.backend.resolveApproval) {
        throw new Error(
          `approval rejected: backend "${run?.modelRef.backendKind}" has no approval pipeline`,
        );
      }
      await entry.backend.resolveApproval(runId, callId, decision);
    },

    async stop(runId) {
      const live = liveRuns.get(runId);
      if (live) {
        await live.segment.stop();
        return;
      }
      const run = await runPort.getRun(runId);
      if (run && isActiveStatus(run.status)) {
        // Zombie: active in DB, no live child. Terminal it, cancel its
        // input, and promote the next queued input so the branch does not
        // stay blocked by a run nobody can drive.
        await runPort.finalizeRun(runId, {
          status: "aborted",
          error: "stale run without live child",
        });
        await runPort.cancelRunInput(runId);
        const next = await runPort.acquireNextRun(run.branchId);
        if (next) {
          void dispatchFn(next.runId).catch((err) => {
            console.error(`[agent-run] chain dispatch failed for ${next.runId}:`, err);
          });
        }
      }
    },

    isLive(runId) {
      return liveRuns.has(runId);
    },

    isInflight(runId) {
      return inflight.has(runId);
    },

    async dispose() {
      execState.disposed = true;
      // Children first: their exit settles every pending outcome/acceptance,
      // which unblocks the in-flight dispatches below.
      await Promise.all(Object.values(backends).map((entry) => entry.backend.dispose()));
      await Promise.allSettled([...inflightPromises.values()]);
      inflightPromises.clear();
    },

    async abortStaleRun(runId) {
      const run = await runPort.getRun(runId);
      if (!run || !isActiveStatus(run.status)) return;
      await runPort.finalizeRun(runId, {
        status: "aborted",
        error: "stale run without live child",
      });
      await runPort.cancelRunInput(runId);
    },

    subscribe(runId, signal) {
      return liveEvents.subscribe(runId, signal);
    },
  };
}
