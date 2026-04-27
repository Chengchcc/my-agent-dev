import type { ContentBlock } from "../../types";

/** Delta extracted from a single streaming chunk for thinking/reasoning content. */
export type ThinkingDelta =
  | { kind: "start" }
  | { kind: "delta"; text: string }
  | { kind: "signature"; signature: string }
  | { kind: "redacted"; data: string }
  | { kind: "stop" };

/** Mutable state for tracking current thinking block during streaming. */
export interface ThinkingState {
  currentBlock: "thinking" | "redacted_thinking" | null;
  textBuffer: string;
  signature?: string;
}

/**
 * Decodes thinking/reasoning content from LLM streaming responses.
 *
 * Different providers use different wire protocols for reasoning content:
 * - Anthropic native: `thinking_delta`, `signature_delta` stream events
 * - DeepSeek/Kimi/GLM: `reasoning_content` / `reasoning_delta` fields
 *
 * This interface encapsulates those differences behind a uniform API.
 */
export interface ThinkingDecoder {
  /** Whether this decoder's thinking blocks require signature preservation on re-submission. */
  requiresSignature: boolean;

  /** Extract a thinking delta from a streaming SSE chunk. Returns null if the chunk is unrelated. */
  decodeStreamChunk(chunk: unknown, state: ThinkingState): ThinkingDelta | null;

  /** Convert a non-streaming response content block into a ContentBlock, or null if unrelated. */
  decodeResponseBlock(block: unknown): ContentBlock | null;

  /** Encode a ContentBlock back into the provider's API request format for turn re-submission. */
  encodeForRequest(block: ContentBlock): unknown;
}
