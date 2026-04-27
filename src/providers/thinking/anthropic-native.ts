import type { ContentBlock } from "../../types";
import type { ThinkingDecoder, ThinkingDelta, ThinkingState } from "./types";

/** Generic SSE event shape from the Anthropic stream. */
interface RawStreamEvent {
  type: string;
  content_block?: {
    type: string;
    id?: string;
    name?: string;
    thinking?: string;
    [key: string]: unknown;
  };
  delta?: {
    type: string;
    thinking?: string;
    signature?: string;
    text?: string;
    partial_json?: string;
    [key: string]: unknown;
  };
  message_delta?: {
    usage?: { output_tokens?: number };
    [key: string]: unknown;
  };
}

/**
 * Decodes Anthropic's native extended thinking protocol.
 *
 * Stream events:
 * - content_block_start with content_block.type === "thinking"
 * - content_block_delta with delta.type === "thinking_delta" → delta.thinking
 * - content_block_delta with delta.type === "signature_delta" → delta.signature
 * - content_block_stop (ends current thinking block)
 */
export class AnthropicNativeDecoder implements ThinkingDecoder {
  requiresSignature = true;

  decodeStreamChunk(chunk: unknown, state: ThinkingState): ThinkingDelta | null {
    const event = chunk as RawStreamEvent;

    if (event.type === "content_block_start") {
      const blockType = event.content_block?.type;
      if (blockType === "thinking") {
        state.currentBlock = "thinking";
        state.textBuffer = "";
        return { kind: "start" };
      }
      if (blockType === "redacted_thinking") {
        state.currentBlock = "redacted_thinking";
        return { kind: "start" };
      }
      return null;
    }

    if (event.type === "content_block_delta") {
      if (state.currentBlock === "thinking" && event.delta?.type === "thinking_delta" && event.delta.thinking) {
        state.textBuffer += event.delta.thinking;
        return { kind: "delta", text: event.delta.thinking };
      }
      if (state.currentBlock === "thinking" && event.delta?.type === "signature_delta" && event.delta.signature) {
        state.signature = event.delta.signature;
        return { kind: "signature", signature: event.delta.signature };
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
    const b = block as { type: string; thinking?: string; signature?: string; data?: string };
    if (b.type === "thinking") {
      return {
        type: "thinking",
        thinking: b.thinking ?? "",
        ...(b.signature ? { signature: b.signature } : {}),
      };
    }
    if (b.type === "redacted_thinking") {
      return { type: "redacted_thinking", data: b.data ?? "" };
    }
    return null;
  }

  encodeForRequest(block: ContentBlock): unknown {
    if (block.type === "thinking") {
      return {
        type: "thinking",
        thinking: block.thinking,
        ...(block.signature ? { signature: block.signature } : {}),
      };
    }
    if (block.type === "redacted_thinking") {
      return { type: "redacted_thinking", data: block.data };
    }
    return null;
  }
}
