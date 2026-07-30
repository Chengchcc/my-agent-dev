import type { Message } from "@my-agent-team/message";
import type { BackendEvent, Usage } from "./event.js";
import type { AgentRunSnapshot, ProjectedHistoryItem, WorkspaceBinding } from "./history.js";

/** Input for creating or resuming an execution session. `start()` and
 *  `resume()` both receive the full snapshot plus the projected history.
 *  Parameterized by `K` so the snapshot's model ref is locked to the Backend's
 *  kind. */
export interface BackendStartInput<K extends string = string> {
  readonly history: readonly ProjectedHistoryItem[];
  readonly run: AgentRunSnapshot<K>;
  readonly workspace: WorkspaceBinding;
  readonly env?: Readonly<Record<string, string>>;
  readonly metadata: {
    readonly conversationId: string;
    readonly agentMemberId: string;
    readonly branchId: string;
    readonly productRevision: number;
  };
}

/** Input for continuing an existing execution session. `run` is required so
 *  model/prompt/tool changes apply on the next Run without a rebuild.
 *  Parameterized by `K` so the snapshot's model ref matches the Backend's kind. */
export interface BackendRunInput<K extends string = string> {
  readonly messages: readonly ProjectedHistoryItem[];
  readonly run: AgentRunSnapshot<K>;
  readonly mode: "normal" | "steer" | "follow_up";
  readonly metadata: {
    readonly branchId: string;
    readonly throughEntryId?: string;
    readonly productRevision: number;
  };
}

/** Execution session reference - the plain identity Product Backend holds for
 *  an open session. It carries only `backendSessionId` and `backendKind`; it is
 *  intentionally not an opaque/unforgeable token. The adapter looks up live
 *  state (client, process, connection) by `backendSessionId` in its own
 *  registry. Lifecycle (open/closed) is NOT a snapshot on this immutable ref -
 *  it belongs to the execution layer and the adapter's live session registry. */
export interface BackendSessionRef<K extends string = string> {
  readonly backendSessionId: string;
  readonly backendKind: K;
}

/** A pending approval, question or permission request awaiting a product
 *  control-plane response. */
export interface PendingAction {
  readonly actionId: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Structured response to a PendingAction. Carries `actionId` for idempotency;
 *  each actionId is consumed at most once. */
export interface PendingActionResponse {
  readonly actionId: string;
  readonly response: unknown;
}

/** Terminal outcome of a run segment. `completed`, `failed`, `aborted` and
 *  `timeout` are Agent Run terminal states. `suspended` is nonterminal: the
 *  Agent Run retains its branch lock and active-run identity, awaiting a
 *  PendingActionResponse. This is the ONLY terminal authority - event streams
 *  must not be interpreted as terminal. */
export type BackendRunOutcome =
  | { readonly status: "completed"; readonly output?: Message; readonly usage?: Usage }
  | { readonly status: "suspended"; readonly pendingAction: PendingAction; readonly usage?: Usage }
  | {
      readonly status: "failed" | "aborted" | "timeout";
      readonly error?: string;
      readonly usage?: Usage;
    };

/** A single run continuation: an event stream plus a terminal outcome promise.
 *  `stop()` requests cancellation; the outcome still resolves. Parameterized by
 *  `K` so events are namespaced to the Backend's kind. */
export interface BackendRunSegment<K extends string = string> {
  readonly events: AsyncIterable<BackendEvent<K>>;
  readonly outcome: Promise<BackendRunOutcome>;
  stop(): Promise<void>;
}

/** A started/resumed session: the session ref and the first run segment.
 *  Returning the first segment alongside the ref avoids a cold-start requiring
 *  an extra `send()` before execution begins. */
export interface BackendSessionRun<
  K extends string = string,
  TRef extends BackendSessionRef<K> = BackendSessionRef<K>,
> {
  readonly session: TRef;
  readonly segment: BackendRunSegment<K>;
}
