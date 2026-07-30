import type {
  BackendRunInput,
  BackendRunSegment,
  BackendSessionRef,
  BackendSessionRun,
  BackendStartInput,
  PendingActionResponse,
} from "./run.js";

/** Declared capabilities. A missing capability must be explicitly handled -
 *  never faked. Branching belongs to Product Context, not the Backend. */
export interface AgentBackendCapabilities {
  readonly persistentSession: boolean;
  readonly nativeResume: boolean;
  readonly nativeSteer: boolean;
  readonly thinkingStream: boolean;
  readonly productTools: "mcp" | "native" | "unsupported";
  readonly pendingActionResponse: boolean;
}

/** The only execution protocol Product Backend depends on.
 *
 *  `K` is the Backend's kind string (e.g. `"claude_code"`, `"coding_agent"`).
 *  It locks extension events to `backend.<K>.*`, brands session refs, and
 *  constrains every input's model ref to the same `K` - so a Backend of one
 *  kind cannot receive another kind's model, events, or session ref.
 *
 *  `TRef` is the adapter's session ref subtype, extending
 *  `BackendSessionRef<K>` with whatever live state (client, process,
 *  connection) the adapter needs. Product Backend never constructs `TRef`
 *  directly; it only passes refs the adapter previously returned. The base
 *  `BackendSessionRef` is a plain identity; the adapter looks up live state by
 *  `backendSessionId` in its own registry. */
export interface AgentBackend<
  K extends string = string,
  TRef extends BackendSessionRef<K> = BackendSessionRef<K>,
> {
  readonly kind: K;
  readonly capabilities: AgentBackendCapabilities;

  start(input: BackendStartInput<K>): Promise<BackendSessionRun<K, TRef>>;

  send(session: TRef, input: BackendRunInput<K>): Promise<BackendRunSegment<K>>;

  resume(
    backendSessionId: string,
    input: BackendStartInput<K>,
  ): Promise<BackendSessionRun<K, TRef>>;

  respond(session: TRef, action: PendingActionResponse): Promise<BackendRunSegment<K>>;

  stop(session: TRef): Promise<void>;

  close(session: TRef): Promise<void>;
}
