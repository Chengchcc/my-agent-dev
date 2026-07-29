import type { Message } from "@my-agent-team/message";
import type { BackendEvent, Usage } from "./event.js";
import type { AgentRunSnapshot, ProjectedHistoryItem, WorkspaceBinding } from "./history.js";

/** Input for creating or resuming an execution session. `start()` and
 *  `resume()` both receive the full snapshot plus the projected history. */
export interface BackendStartInput {
  readonly history: readonly ProjectedHistoryItem[];
  readonly run: AgentRunSnapshot;
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
 *  model/prompt/tool changes apply on the next Run without a rebuild. */
export interface BackendRunInput {
  readonly messages: readonly ProjectedHistoryItem[];
  readonly run: AgentRunSnapshot;
  readonly mode: "normal" | "steer" | "follow_up";
  readonly metadata: {
    readonly branchId: string;
    readonly throughEntryId?: string;
    readonly productRevision: number;
  };
}

/** Adapter-private live session handle. Product Backend reads only the opaque
 *  `backendSessionId`, backend kind and lifecycle state; it must not read or
 *  mutate Runtime-internal transcript. */
export interface BackendSessionHandle {
  readonly backendSessionId: string;
  readonly backendKind: string;
  readonly state: "open" | "closed";
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
 *  PendingActionResponse. */
export type BackendRunOutcome =
  | { readonly status: "completed"; readonly output?: Message; readonly usage?: Usage }
  | { readonly status: "suspended"; readonly pendingAction: PendingAction; readonly usage?: Usage }
  | {
      readonly status: "failed" | "aborted" | "timeout";
      readonly error?: string;
      readonly usage?: Usage;
    };

/** A single run continuation: an event stream plus a terminal outcome promise.
 *  `stop()` requests cancellation; the outcome still resolves. */
export interface BackendRunSegment {
  readonly events: AsyncIterable<BackendEvent>;
  readonly outcome: Promise<BackendRunOutcome>;
  stop(): Promise<void>;
}

/** A started/resumed session: the live handle and the first run segment.
 *  Returning the first segment alongside the handle avoids a cold-start
 *  requiring an extra `send()` before execution begins. */
export interface BackendSessionRun {
  readonly session: BackendSessionHandle;
  readonly segment: BackendRunSegment;
}
