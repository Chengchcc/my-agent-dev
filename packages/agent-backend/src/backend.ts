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

/** The only execution protocol Product Backend depends on. `kind` identifies
 *  the backend (e.g. "claude_code", "coding_agent") and matches
 *  `BackendModelRef.backendKind`. `start()` and `resume()` return handle plus
 *  first segment; `send()` continues an open session. */
export interface AgentBackend {
  readonly kind: string;
  readonly capabilities: AgentBackendCapabilities;

  start(input: BackendStartInput): Promise<BackendSessionRun>;

  send(session: BackendSessionHandle, input: BackendRunInput): Promise<BackendRunSegment>;

  resume(backendSessionId: string, input: BackendStartInput): Promise<BackendSessionRun>;

  respond(session: BackendSessionHandle, action: PendingActionResponse): Promise<BackendRunSegment>;

  stop(session: BackendSessionHandle): Promise<void>;

  close(session: BackendSessionHandle): Promise<void>;
}
