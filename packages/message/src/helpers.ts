import type { Message, MessageState } from "./message.js";
import { parseMessageRevision } from "./parser.js";
import type { MessageRevision } from "./revision.js";

/** Build a messageId for a run's N-th assistant output.
 *  Ordinal distinguishes multiple assistant messages within the same run
 *  (e.g. pre-tool vs post-tool segments). Most runs produce exactly one
 *  assistant message (ordinal = 0). */
export function assistantMessageId(runId: string, ordinal: number): string {
  return `run:${runId}:assistant:${ordinal}`;
}

/** Human message id: msg:{conversationId}:{senderMemberId}:{uuid} */
export function humanMessageId(conversationId: string, senderMemberId: string): string {
  return `msg:${conversationId}:${senderMemberId}:${crypto.randomUUID()}`;
}

/** System notification id: sys:{conversationId}:{tag}:{uuid} */
export function systemMessageId(conversationId: string, tag: string): string {
  return `sys:${conversationId}:${tag}:${crypto.randomUUID()}`;
}

// ─── State predicates ─────────────────────────────────────────

const OPEN_STATES: ReadonlySet<MessageState> = new Set(["pending", "streaming", "waiting"]);

/** Whether the state means the message is still open (not terminal). */
export function isOpenMessageState(state: MessageState): boolean {
  return OPEN_STATES.has(state);
}

const TERMINAL_STATES: ReadonlySet<MessageState> = new Set(["done", "error"]);

/** Whether the state means the message has reached a terminal state. */
export function isTerminalMessageState(state: MessageState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Whether the state means the message succeeded (terminal success, not error).
 *  Narrower than isTerminalMessageState — only matches "done". */
export function isSucceededMessageState(state: MessageState): boolean {
  return state === "done";
}

// ─── Content codec ────────────────────────────────────────────

/** Extract displayable text from message content (revision or message).
 *  Prefers .text, falls back to concatenating text blocks.
 *  Accepts a structural type so it works for both Message and MessageRevision. */
export function extractText(input: {
  text?: string | null;
  blocks?: readonly { type: string; text?: string }[] | null;
}): string {
  return (
    input.text ??
    input.blocks
      ?.filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join(" ") ??
    ""
  );
}

/** Deserialize ledger content string to a MessageRevision if possible.
 *  Returns the revision on success, or { raw } with the parsed JSON / raw string on failure. */
export function deserializeLedgerContent(content: string): MessageRevision | { raw: unknown } {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parseMessageRevision(parsed);
  } catch {
    try {
      return { raw: JSON.parse(content) };
    } catch {
      return { raw: content };
    }
  }
}

/** Apply a MessageRevision to a Message (upsert by messageId).
 *  Returns a new Message object. If `message` is null/undefined,
 *  creates a new Message from the revision. */
export function mergeMessageRevision(
  message: Message | null | undefined,
  revision: MessageRevision,
): Message {
  const base: Message = message ?? {
    id: revision.messageId,
    role: revision.role,
    createdAt: revision.updatedAt,
  };

  return {
    ...base,
    id: revision.messageId,
    role: revision.role,
    state: revision.state,
    text: revision.text ?? base.text,
    blocks: revision.blocks ?? base.blocks,
    tools: revision.tools ?? base.tools,
    conversationId: revision.conversationId ?? base.conversationId,
    visibility: revision.visibility ?? base.visibility,
    updatedAt: revision.updatedAt,
    error: revision.error ?? base.error,
    runStatus: revision.runStatus ?? base.runStatus,
  };
}
