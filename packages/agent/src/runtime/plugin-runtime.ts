import type { AIMessageChunk } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { SessionStore } from "../persistence/session-store.js";
import type { CodingAgentLoopEvent } from "./agent-event.js";

/** Runtime capabilities injected into plugin hooks. Mirrors a subset of
 *  pi's ExtensionContext: model stream, store, workspace, event emit.
 *
 *  Plugins receive this as the last parameter of each hook, so factory
 *  closures capture configuration (modelRef, enabled) while runtime
 *  capabilities come from the `rt` argument - same pattern as pi's
 *  `ExtensionAPI` parameter, without jiti or dynamic loading. */
export interface PluginRuntime {
  /** Stream a model call (bounded by the same modelTimeoutMs as the main
   *  loop). Plugins use this for recap/pet - never for the main agent turn. */
  readonly streamModel: (
    providerId: string,
    modelId: string,
    messages: readonly Message[],
    opts?: { signal?: AbortSignal },
  ) => AsyncIterable<AIMessageChunk>;

  /** Run an ephemeral side-channel model turn: appends `prompt` as a user
   *  message to the current branch history, streams through the run's model
   *  (with the same system prompt + tool catalog for prompt cache), collects
   *  text output, and discards any tool calls. The result is NEVER persisted
   *  to the session branch — it's a pure side-channel read.
   *
   *  Inspired by omp's AgentSession.runEphemeralTurn. Used by recap/title
   *  so plugins don't need to manually construct messages or know the model
   *  ref. One call: `const text = await rt.runEphemeralTurn(prompt);` */
  /** Set by the loop (not by external code). Optional on the interface
   *  so run-runtime/tests don't need a stub. */
  readonly runEphemeralTurn?: (prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>;

  /** Session store (read-only for plugins): branch history, todo state. */
  readonly store: SessionStore;
  readonly sessionId: string;

  /** Run workspace root. */
  readonly workspaceRoot: string;

  /** Emit a UI-transient event to the Run SSE (never to History). */
  readonly emit: (event: CodingAgentLoopEvent) => void;

  /** The run's abort signal (for graceful shutdown). */
  readonly signal: AbortSignal;
}
