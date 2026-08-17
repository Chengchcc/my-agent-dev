import type { ToolResultBlock, ToolUseBlock } from "./content-block.js";
import type { Message } from "./message.js";

/**
 * Canonical message contract (ADR 0017):
 * - `user`: text and/or tool_result blocks
 * - `assistant`: text and/or tool_use blocks — NEVER tool_result
 * - `tool`: tool_result blocks paired with an existing tool_use id
 *
 * Normalize a message sequence to this contract. Assistant messages that
 * carry tool_result blocks (a display-shaped merge some producers emit) are
 * split into an assistant message with text/tool_use only plus a following
 * `tool` message with the paired results. Results whose tool_use_id has no
 * matching tool_use in the same message are dropped — they have no valid
 * canonical position. Pure messages pass through unchanged.
 *
 * Shape-driven and producer-agnostic: this is the single normalization point
 * at the adapter boundary, so any future oma type is covered without
 * backend changes.
 */
export function normalizeCanonicalMessages(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.blocks?.some((b) => b.type === "tool_result")) {
      const toolUseIds = new Set(
        m.blocks.filter((b): b is ToolUseBlock => b.type === "tool_use").map((b) => b.id),
      );
      const results = m.blocks.filter(
        (b): b is ToolResultBlock =>
          b.type === "tool_result" && b.tool_use_id !== undefined && toolUseIds.has(b.tool_use_id),
      );
      const kept = m.blocks.filter((b) => b.type !== "tool_result");
      if (kept.length > 0) out.push({ ...m, blocks: kept });
      if (results.length > 0) out.push({ role: "tool", blocks: results });
      continue;
    }
    out.push(m);
  }
  return out;
}
