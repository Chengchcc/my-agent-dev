import type { ContentBlock } from "../../types";
import type { ThinkingDecoder, ThinkingDelta, ThinkingState } from "./types";

interface RawStreamEvent {
  type: string;
  content_block?: { type: string; [key: string]: unknown };
  delta?: {
    type: string;
    reasoning?: string;
    reasoning_content?: string;
    text?: string;
    [key: string]: unknown;
  };
}

/**
 * Decoder for providers that expose reasoning via `reasoning_delta` events
 * (DeepSeek-R1, Kimi, GLM via Anthropic-compatible protocol).
 *
 * Unlike Anthropic native thinking, this decoder:
 * - Detects reasoning from the delta type ("reasoning_delta") rather than content_block type
 * - Auto-enters thinking state on first reasoning delta (no explicit content_block_start signal)
 * - Detects the end of reasoning by a subsequent text_delta or content_block_stop
 * - Does NOT preserve a signature (not required by these backends)
 */
export class ReasoningContentDecoder implements ThinkingDecoder {
  requiresSignature = false;

  decodeStreamChunk(chunk: unknown, state: ThinkingState): ThinkingDelta | null {
    const event = chunk as RawStreamEvent;

    if (event.type === "content_block_delta") {
      const delta = event.delta;
      if (!delta) return null;

      // Detect reasoning start: any delta with reasoning content
      if (delta.type === "reasoning_delta") {
        const text = delta.reasoning ?? delta.reasoning_content ?? "";
        if (state.currentBlock !== "thinking") {
          state.currentBlock = "thinking";
          state.textBuffer = "";
        }
        if (text) {
          state.textBuffer += text;
          return { kind: "delta", text };
        }
        return null;
      }

      // Text delta signals end of reasoning block (boundary detection)
      if (delta.type === "text_delta" && state.currentBlock === "thinking") {
        state.currentBlock = null;
      }

      return null;
    }

    if (event.type === "content_block_stop" && state.currentBlock !== null) {
      state.currentBlock = null;
      return { kind: "stop" };
    }

    return null;
  }

  decodeResponseBlock(block: unknown): ContentBlock | null {
    const b = block as { type: string; reasoning?: string; thinking?: string; data?: string };
    if (b.type === "reasoning") {
      return { type: "thinking", thinking: b.reasoning ?? "" };
    }
    if (b.type === "thinking") {
      return { type: "thinking", thinking: b.thinking ?? "" };
    }
    if (b.type === "redacted_thinking") {
      return { type: "redacted_thinking", data: b.data ?? "" };
    }
    return null;
  }

  encodeForRequest(block: ContentBlock): unknown {
    if (block.type === "thinking") {
      return { type: "thinking", thinking: block.thinking };
    }
    if (block.type === "redacted_thinking") {
      return { type: "redacted_thinking", data: block.data };
    }
    return null;
  }
}
