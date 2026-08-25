/** Event/usage mapping from the claude stream-json wire format to
 *  CoreBackendEvent. Terminal truth stays with the Run outcome. Usage is
 *  accumulated from the final `result.modelUsage` map (authoritative, per
 *  model); `total_cost_usd` feeds costUsd. */

import type { BackendEvent, Usage } from "@chengchenccc/agent-contract";
import type { Message } from "@chengchenccc/message";
import type { ClaudeEvent } from "./wire.js";

export interface ClaudeRunAccumulator {
  readonly events: BackendEvent<"claude_code">[];
  usage: Usage;
  /** Assistant text blocks (may repeat across snapshot events — the UI
   *  collapses by messageId; the outcome's final answer comes from
   *  result.result). */
  readonly assistantTexts: string[];
  /** Session id captured from init/result (resume key, ADR 0002). */
  sessionId: string | null;
  /** Terminal signal from the `result` event. */
  result: { result: string | null; isError: boolean } | null;
  /** Error surfaced by the `error` event type. */
  error: string | null;
  /** tool_use callId → tool name (the tool_result block carries only the
   *  id; the completed event must restore the real name). */
  readonly toolNames: Map<string, string>;
}

export function createClaudeAccumulator(): ClaudeRunAccumulator {
  return {
    events: [],
    usage: {},
    assistantTexts: [],
    sessionId: null,
    result: null,
    error: null,
    toolNames: new Map(),
  };
}

export function mapClaudeEvent(acc: ClaudeRunAccumulator, evt: ClaudeEvent): boolean {
  switch (evt.type) {
    case "system": {
      if (evt.session_id) acc.sessionId = evt.session_id;
      return false;
    }
    case "assistant": {
      const msg = evt.message;
      if (!msg?.content) return false;
      let visible = false;
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          acc.events.push({ type: "text_delta", text: block.text });
          acc.assistantTexts.push(block.text);
          visible = true;
        } else if (block.type === "thinking" && (block.text ?? block.thinking)) {
          acc.events.push({ type: "thinking_delta", text: block.thinking ?? block.text! });
          visible = true;
        } else if (block.type === "tool_use" && block.id && block.name) {
          acc.toolNames.set(block.id, block.name);
          acc.events.push({
            type: "native_tool_started",
            toolName: block.name,
            callId: block.id,
          });
          visible = true;
        }
      }
      return visible;
    }
    case "user": {
      const msg = evt.message;
      if (!msg?.content) return false;
      let visible = false;
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          acc.events.push({
            type: "native_tool_completed",
            toolName: acc.toolNames.get(block.tool_use_id) ?? "claude_tool",
            callId: block.tool_use_id,
            result: {
              output:
                typeof block.content === "string" ? block.content : JSON.stringify(block.content),
              isError: block.is_error === true,
            },
          });
          visible = true;
        }
      }
      return visible;
    }
    case "result": {
      acc.result = {
        result: evt.result ?? null,
        isError: evt.is_error === true,
      };
      if (evt.session_id) acc.sessionId = evt.session_id;
      // Authoritative usage: modelUsage keyed by model name.
      if (evt.modelUsage) {
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        for (const entry of Object.values(evt.modelUsage)) {
          inputTokens += entry.inputTokens ?? 0;
          outputTokens += entry.outputTokens ?? 0;
          cacheReadTokens += entry.cacheReadInputTokens ?? 0;
          cacheWriteTokens += entry.cacheCreationInputTokens ?? 0;
        }
        acc.usage = {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          ...(evt.total_cost_usd !== undefined ? { costUsd: evt.total_cost_usd } : {}),
        };
      }
      return true;
    }
    case "error": {
      acc.error = evt.error_text ?? "claude error event";
      return true;
    }
    default:
      return false;
  }
}

/** The final answer is the result event's text (the run's terminal output);
 *  fall back to the last accumulated assistant text. */
export function finalText(acc: ClaudeRunAccumulator): string | null {
  if (acc.result?.result) return acc.result.result;
  return acc.assistantTexts.at(-1) ?? null;
}

/** Build the canonical outcome messages. For claude the result text is the
 *  single final answer (ADR 0017: last assistant message with text). */
export function buildOutcomeMessages(text: string | null): Message[] {
  return text ? [{ role: "assistant", text }] : [];
}
