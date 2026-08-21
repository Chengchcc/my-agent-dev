import type { OmaRuntime } from "../core/create-runtime.js";
import {
  appendSessionCompaction,
  appendSessionMessages,
  appendSessionTitle,
  loadSessionMessages,
  newSessionId,
} from "./session-file.js";

/** Shared session persistence for the interactive CLI modes (TUI) and the
 *  one-shot modes (print). Mirrors the RPC mode's session semantics
 *  (ADR 0003 decision 6): the CLI owns its session file; the product
 *  stores only the session id. A completed turn (input + assistant/tool
 *  messages + compaction summaries) is appended after the run. */

/** Finalize a turn in the session file: writes compaction summaries and the
 *  auto title. Conversational messages are written in REAL TIME via
 *  createOmaRuntime's onPersistMessages (pi appendMessage) when the caller
 *  wires it; `messages` is the fallback batch for one-shot modes (print)
 *  that do not use real-time persistence. */
export async function persistSessionTurn(opts: {
  sessionId: string;
  cwd: string;
  runtime: OmaRuntime;
  /** Messages not already written by the real-time hook (print mode). */
  messages?: readonly unknown[];
  /** The run's auto-generated title (outcome.title), when present. */
  title?: string;
}): Promise<void> {
  if (opts.messages && opts.messages.length > 0) {
    appendSessionMessages(opts.sessionId, opts.cwd, opts.messages);
  }
  for (const summary of await opts.runtime.compactions()) {
    appendSessionCompaction(opts.sessionId, summary);
  }
  if (opts.title) appendSessionTitle(opts.sessionId, opts.title);
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
