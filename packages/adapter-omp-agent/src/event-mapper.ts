/** Event/usage mapping from the omp wire format to CoreBackendEvent.
 *  One per-Run instance accumulates transient state (text deltas, usage,
 *  per-turn assistant texts). Terminal truth stays with the Run outcome —
 *  events never decide terminal state. */

import type { BackendEvent, Usage } from "@my-agent-team/agent-backend";
import type { Message } from "@my-agent-team/message";
import type { OmpEvent, OmpMessageEvent } from "./wire.js";

export interface OmpRunAccumulator {
  /** Emit one core/extension event (already final — pushed as-is). */
  readonly events: BackendEvent<"omp">[];
  /** Accumulated token usage (from assistant message_end usage). */
  usage: Usage;
  /** Per-turn assistant texts, in order (from turn_end / agent_end). */
  readonly assistantTexts: string[];
  /** Error surfaced by the `error` event type. */
  error: string | null;
}

export function createOmpAccumulator(): OmpRunAccumulator {
  return { events: [], usage: {}, assistantTexts: [], error: null };
}

/** Reduce one wire event into the accumulator. Returns true when the event
 *  carried product-visible content (delta/tool/error) — callers may use it
 *  for debug logging. */
export function mapOmpEvent(acc: OmpRunAccumulator, evt: OmpEvent): boolean {
  switch (evt.type) {
    case "message_update": {
      const ae = evt.assistantMessageEvent;
      if (!ae) return false;
      if (ae.type === "text_delta" && ae.delta) {
        acc.events.push({ type: "text_delta", text: ae.delta });
        return true;
      }
      if (ae.type === "thinking_delta" && ae.delta) {
        acc.events.push({ type: "thinking_delta", text: ae.delta });
        return true;
      }
      return false;
    }
    case "tool_execution_start": {
      if (!evt.toolCallId || !evt.toolName) return false;
      acc.events.push({
        type: "native_tool_started",
        toolName: evt.toolName,
        callId: evt.toolCallId,
      });
      return true;
    }
    case "tool_execution_end": {
      if (!evt.toolCallId || !evt.toolName) return false;
      acc.events.push({
        type: "native_tool_completed",
        toolName: evt.toolName,
        callId: evt.toolCallId,
        result: {
          output: typeof evt.result === "string" ? evt.result : JSON.stringify(evt.result),
          isError: evt.isError === true,
        },
      });
      return true;
    }
    case "message_end": {
      const msg = evt.message;
      if (!msg?.usage) return false;
      const u = msg.usage;
      acc.usage = {
        inputTokens: (acc.usage.inputTokens ?? 0) + u.input,
        outputTokens: (acc.usage.outputTokens ?? 0) + u.output,
        cacheReadTokens: (acc.usage.cacheReadTokens ?? 0) + u.cacheRead,
        cacheWriteTokens: (acc.usage.cacheWriteTokens ?? 0) + u.cacheWrite,
        ...(u.cost?.total !== undefined
          ? { costUsd: (acc.usage.costUsd ?? 0) + u.cost.total }
          : {}),
      };
      return true;
    }
    case "turn_end": {
      const text = messageText(evt.message);
      if (text) acc.assistantTexts.push(text);
      return text !== null;
    }
    case "agent_end": {
      // Canonical transcript: the last assistant message with text is the
      // run's final answer. Prefer this over accumulated turn_end texts.
      if (evt.messages) {
        const texts: string[] = [];
        for (const m of evt.messages) {
          if (m.role === "assistant") {
            const t = messageText(m);
            if (t) texts.push(t);
          }
        }
        if (texts.length > 0) {
          acc.assistantTexts.length = 0;
          acc.assistantTexts.push(...texts);
        }
      }
      return false;
    }
    case "error": {
      acc.error =
        typeof evt.message === "string" && evt.message ? evt.message : JSON.stringify(evt.message);
      return acc.error !== null;
    }
    case "auto_retry_end": {
      if (evt.success === false && typeof evt.finalError === "string" && evt.finalError) {
        acc.error = evt.finalError;
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/** Concatenated text content of an omp message (text blocks only). */
function messageText(msg: OmpMessageEvent | undefined): string | null {
  if (!msg?.content) return null;
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "text" && block.text) parts.push(block.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Build the canonical outcome messages from accumulated assistant texts.
 *  Each text becomes one assistant Message (ADR 0017: the final answer is
 *  the last assistant message with text). */
export function buildOutcomeMessages(texts: readonly string[]): Message[] {
  return texts.map((text) => ({ role: "assistant", text }));
}
