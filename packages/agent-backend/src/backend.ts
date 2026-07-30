import type {
  BackendRunInput,
  BackendRunSegment,
  BackendSessionHandle,
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
 *  It locks extension events to `backend.<K>.*` and brands session handles so a
 *  Backend of one kind cannot emit or accept another kind's events/handles.
 *
 *  `THandle` is the adapter's private session handle subtype, extending
 *  `BackendSessionHandle<K>` with whatever live state (client, process,
 *  connection) the adapter needs. Product Backend never constructs `THandle`
 *  directly; it only passes handles the adapter previously returned. */
export interface AgentBackend<
  K extends string = string,
  THandle extends BackendSessionHandle<K> = BackendSessionHandle<K>,
> {
  readonly kind: K;
  readonly capabilities: AgentBackendCapabilities;

  start(input: BackendStartInput): Promise<BackendSessionRun<K, THandle>>;

  send(session: THandle, input: BackendRunInput): Promise<BackendRunSegment<K>>;

  resume(
    backendSessionId: string,
    input: BackendStartInput,
  ): Promise<BackendSessionRun<K, THandle>>;

  respond(session: THandle, action: PendingActionResponse): Promise<BackendRunSegment<K>>;

  stop(session: THandle): Promise<void>;

  close(session: THandle): Promise<void>;
}
