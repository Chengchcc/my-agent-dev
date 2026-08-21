import type { Message } from "@chengchenccc/message";
import type { OmaRuntime } from "../core/create-runtime.js";
import {
  appendSessionCompaction,
  appendSessionMessages,
  loadSessionMessages,
  newSessionId,
} from "./session-file.js";

/** Shared session persistence for the interactive CLI modes (TUI) and the
 *  one-shot modes (print). Mirrors the RPC mode's session semantics
 *  (ADR 0003 decision 6): the CLI owns its session file; the product
 *  stores only the session id. A completed turn (input + assistant/tool
 *  messages + compaction summaries) is appended after the run. */

/** Persist a completed turn into the session file and return the updated
 *  transcript. No-op (returns the previous transcript) for non-completed
 *  outcomes. */
export async function persistSessionTurn(opts: {
  sessionId: string;
  cwd: string;
  runtime: OmaRuntime;
  /** The completed outcome's messages (assistant + tool), wire-loose. */
  outcomeMessages: readonly unknown[];
  /** The user input message that produced this turn, wire-loose. */
  inputMessage: Record<string, unknown> | Message;
  /** The transcript loaded before this turn. */
  previousMessages: readonly Record<string, unknown>[];
}): Promise<Record<string, unknown>[]> {
  appendSessionMessages(opts.sessionId, opts.cwd, [opts.inputMessage, ...opts.outcomeMessages]);
  for (const summary of await opts.runtime.compactions()) {
    appendSessionCompaction(opts.sessionId, summary);
  }
  return [
    ...opts.previousMessages,
    opts.inputMessage as Record<string, unknown>,
    ...(opts.outcomeMessages as Record<string, unknown>[]),
  ];
}

/** Resolve the session for a new TUI turn: a --session id resumes that
 *  file (missing/corrupt file degrades to fresh); otherwise a new id. */
export function resolveSession(sessionId?: string): {
  sessionId: string;
  messages: Record<string, unknown>[];
} {
  const id = sessionId ?? newSessionId();
  return { sessionId: id, messages: loadSessionMessages(id) };
}
