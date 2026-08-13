/** Event/usage mapping from the pi wire format to CoreBackendEvent.
 *  One per-Run instance accumulates transient state. Terminal truth stays
 *  with the Run outcome — events never decide terminal state.
 *
 *  Usage extraction differs from omp: pi's `turn_end` message carries the
 *  authoritative usage (solo's pi parser reads it there too). */

import type { BackendEvent, Usage } from "@my-agent-team/agent-backend";
import type { Message } from "@my-agent-team/message";
import type { PiEvent, PiMessageEvent } from "./wire.js";

export interface PiRunAccumulator {
  /** Emit one core/extension event (already final — pushed as-is). */
  readonly events: BackendEvent<"pi">[];
  /** Accumulated token usage (from turn_end message usage). */
  usage: Usage;
  /** Per-turn assistant texts, in order (from turn_end / agent_end). */
  readonly assistantTexts: string[];
  /** Error surfaced by the `error` event type. */
  error: string | null;
  /** Native session id from the `session` event (the CLI owns its session;
   *  the product stores only this opaque reference — ADR 0003). */
  sessionId: string | null;
}

export function createPiAccumulator(): PiRunAccumulator {
  return { events: [], usage: {}, assistantTexts: [], error: null, sessionId: null };
}

/** Reduce one wire event into the accumulator. */
export function mapPiEvent(acc: PiRunAccumulator, evt: PiEvent): boolean {
  switch (evt.type) {
    case "session": {
      if (evt.id) acc.sessionId = evt.id;
      return false;
    }
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
    case "turn_end": {
      const msg = evt.message;
      const text = messageText(msg);
      if (text) acc.assistantTexts.push(text);
      // pi carries the authoritative usage on turn_end's message.
      if (msg?.usage) {
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
      }
      return text !== null || msg?.usage !== undefined;
    }
    case "agent_end": {
      // Canonical transcript: the last assistant message with text is the
      // run's final answer.
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

/** Concatenated text content of a pi message (text blocks only). */
function messageText(msg: PiMessageEvent | undefined): string | null {
  if (!msg?.content) return null;
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "text" && block.text) parts.push(block.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Build the canonical outcome messages from accumulated assistant texts. */
export function buildOutcomeMessages(texts: readonly string[]): Message[] {
  return texts.map((text) => ({ role: "assistant", text }));
}
