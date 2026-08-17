import type { BackendKind } from "./kinds.js";
import type { BackendCatalog } from "./model.js";
import type { BackendInputMessage, BackendRunInput, BackendRunSegment } from "./run.js";

/** One registered backend kind: the AgentBackend plus its model catalog.
 *  The registry is the Product Backend's single dispatch table; execution
 *  resolves `modelRef.backendKind` against it and reports a clear error for
 *  unknown/unregistered kinds. */
export interface BackendRegistryEntry {
  readonly backend: AgentBackend<BackendKind>;
  readonly catalog: BackendCatalog;
}

/** Partial: a deployment may omit kinds (e.g. pi not installed). */
export type BackendRegistry = Partial<Record<BackendKind, BackendRegistryEntry>>;

/** The only execution protocol Product Backend depends on. Run-centric: one
 *  non-steer input maps to exactly one `execute()` call, one loop, one
 *  `BackendRunOutcome`. There is no session lifecycle - `runId` is the only
 *  execution identity and every Run rebuilds its input from the full Product
 *  Context projection. `steer` injects into the CURRENT live Run only; `stop`
 *  terminates the target Run.
 *
 *  `K` is the Backend's kind string (e.g. `"oma"`). It locks
 *  extension events to `backend.<K>.*` and constrains every input's model ref
 *  to the same `K`. */
export interface AgentBackend<K extends string = string> {
  readonly kind: K;

  /** Start a fresh Run: full history + input + run snapshot + workspace.
   *  The segment's outcome is the run's ONLY terminal result. Same runId +
   *  same payload is idempotent (replays the accepted result); same runId +
   *  different payload conflicts. */
  execute(input: BackendRunInput<K>): Promise<BackendRunSegment<K>>;

  /** Inject a steer input into the live Run `runId`. No new Run, no new
   *  outcome. Fails explicitly when the Run is not live - never silently
   *  converted into a normal input. */
  steer(runId: string, input: BackendInputMessage): Promise<void>;

  /** Request cancellation of the live Run `runId`. The segment's outcome
   *  still resolves (aborted). */
  stop(runId: string): Promise<void>;

  /** Shut down ALL children deterministically (Backend shutdown path):
   *  reject new executes, cancel queued spawns, abort accepted children,
   *  SIGTERM pre-acceptance children, SIGKILL after a bounded grace, and
   *  await every child's exit. Never blocks on a stuck acceptance. */
  dispose(): Promise<void>;
}
