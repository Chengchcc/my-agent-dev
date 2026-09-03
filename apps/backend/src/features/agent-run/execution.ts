import type { BackendEvent } from "@chengchenccc/agent-contract";
import type { AgentRun } from "./domain.js";
import { isTerminalStatus } from "./domain.js";
import { createExecutionDispatcher } from "./execution-dispatch.js";
import { createLiveEventBus } from "./execution-live.js";
import { createExecutionService } from "./execution-service.js";
import type {
  AgentRunExecutionDeps,
  AgentRunExecutionService,
  LiveRun,
} from "./execution-types.js";

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

  return createExecutionService({
    deps,
    liveEvents,
    liveRuns,
    inflight,
    inflightPromises,
    state: execState,
    dispatchFn,
    entryFor,
  });
}
