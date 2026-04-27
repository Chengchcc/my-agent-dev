import { describe, it, expect } from "bun:test";
import { AnthropicNativeDecoder } from "../../src/providers/thinking/anthropic-native";
import { ReasoningContentDecoder } from "../../src/providers/thinking/reasoning-content";
import type { ThinkingState } from "../../src/providers/thinking/types";

describe("AnthropicNativeDecoder", () => {
  const decoder = new AnthropicNativeDecoder();

  it("requires signature preservation", () => {
    expect(decoder.requiresSignature).toBe(true);
  });

  describe("decodeStreamChunk", () => {
    function freshState(): ThinkingState {
      return { currentBlock: null, textBuffer: "" };
    }

    it("returns null for non-thinking content_block_start", () => {
      const state = freshState();
      const result = decoder.decodeStreamChunk(
        { type: "content_block_start", content_block: { type: "text", text: "hi" } },
        state,
      );
      expect(result).toBeNull();
    });

    it("returns start delta for thinking content_block_start", () => {
      const state = freshState();
      const result = decoder.decodeStreamChunk(
        { type: "content_block_start", content_block: { type: "thinking", thinking: "" } },
        state,
      );
      expect(result).toEqual({ kind: "start" });
      expect(state.currentBlock).toBe("thinking");
    });

    it("returns text delta for thinking_delta", () => {
      const state: ThinkingState = { currentBlock: "thinking", textBuffer: "" };
      const result = decoder.decodeStreamChunk(
        { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Hmm" } },
        state,
      );
      expect(result).toEqual({ kind: "delta", text: "Hmm" });
      expect(state.textBuffer).toBe("Hmm");
    });

    it("returns signature delta for signature_delta", () => {
      const state: ThinkingState = { currentBlock: "thinking", textBuffer: "..." };
      const result = decoder.decodeStreamChunk(
        { type: "content_block_delta", delta: { type: "signature_delta", signature: "sig42" } },
        state,
      );
      expect(result).toEqual({ kind: "signature", signature: "sig42" });
      expect(state.signature).toBe("sig42");
    });

    it("returns stop delta for content_block_stop during thinking", () => {
      const state: ThinkingState = { currentBlock: "thinking", textBuffer: "done" };
      const result = decoder.decodeStreamChunk(
        { type: "content_block_stop" },
        state,
      );
      expect(result).toEqual({ kind: "stop" });
      expect(state.currentBlock).toBeNull();
    });

    it("accumulates multiple thinking deltas", () => {
      const state: ThinkingState = { currentBlock: "thinking", textBuffer: "" };
      decoder.decodeStreamChunk(
        { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Hello" } },
        state,
      );
      decoder.decodeStreamChunk(
        { type: "content_block_delta", delta: { type: "thinking_delta", thinking: " world" } },
        state,
      );
      expect(state.textBuffer).toBe("Hello world");
    });
  });

  describe("decodeResponseBlock", () => {
    it("converts thinking block to ContentBlock", () => {
      const result = decoder.decodeResponseBlock({
        type: "thinking",
        thinking: "chain of thought",
        signature: "sig1",
      });
      expect(result).toEqual({
        type: "thinking",
        thinking: "chain of thought",
        signature: "sig1",
      });
    });

    it("returns null for text block", () => {
      const result = decoder.decodeResponseBlock({ type: "text", text: "hello" });
      expect(result).toBeNull();
    });

    it("returns redacted_thinking block", () => {
      const result = decoder.decodeResponseBlock({
        type: "redacted_thinking",
        data: "encrypted",
      });
      expect(result).toEqual({ type: "redacted_thinking", data: "encrypted" });
    });
  });

  describe("encodeForRequest", () => {
    it("encodes thinking block for API request with signature", () => {
      const result = decoder.encodeForRequest({
        type: "thinking",
        thinking: "...",
        signature: "sig42",
      });
      expect(result).toEqual({
        type: "thinking",
        thinking: "...",
        signature: "sig42",
      });
    });

    it("encodes redacted_thinking block for API request", () => {
      const result = decoder.encodeForRequest({
        type: "redacted_thinking",
        data: "encrypted",
      });
      expect(result).toEqual({ type: "redacted_thinking", data: "encrypted" });
    });
  });
});

describe("ReasoningContentDecoder", () => {
  const decoder = new ReasoningContentDecoder();

  it("does NOT require signature preservation", () => {
    expect(decoder.requiresSignature).toBe(false);
  });

  describe("decodeStreamChunk", () => {
    function freshState(): ThinkingState {
      return { currentBlock: null, textBuffer: "" };
    }

    it("detects reasoning_delta in content_block_delta", () => {
      const state: ThinkingState = { currentBlock: "thinking", textBuffer: "" };
      const result = decoder.decodeStreamChunk(
        { type: "content_block_delta", delta: { type: "reasoning_delta", reasoning: "Hmm..." } },
        state,
      );
      expect(result).toEqual({ kind: "delta", text: "Hmm..." });
    });

    it("auto-starts thinking state on first reasoning delta", () => {
      const state = freshState();
      const result = decoder.decodeStreamChunk(
        { type: "content_block_delta", delta: { type: "reasoning_delta", reasoning: "Think" } },
        state,
      );
      expect(result).toEqual({ kind: "delta", text: "Think" });
      expect(state.currentBlock).toBe("thinking");
    });

    it("detects reasoning_content field in delta", () => {
      const state: ThinkingState = { currentBlock: "thinking", textBuffer: "" };
      const result = decoder.decodeStreamChunk(
        { type: "content_block_delta", delta: { type: "reasoning_delta", reasoning_content: "Deep thought" } },
        state,
      );
      expect(result).toEqual({ kind: "delta", text: "Deep thought" });
    });

    it("returns stop on content_block_stop when thinking", () => {
      const state: ThinkingState = { currentBlock: "thinking", textBuffer: "done" };
      const result = decoder.decodeStreamChunk({ type: "content_block_stop" }, state);
      expect(result).toEqual({ kind: "stop" });
      expect(state.currentBlock).toBeNull();
    });

    it("stops thinking on text_delta (boundary detection)", () => {
      const state: ThinkingState = { currentBlock: "thinking", textBuffer: "reasoned" };
      const result = decoder.decodeStreamChunk(
        { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
        state,
      );
      expect(result).toBeNull();
      expect(state.currentBlock).toBeNull();
    });
  });

  describe("decodeResponseBlock", () => {
    it("converts reasoning block to ContentBlock (no signature)", () => {
      const result = decoder.decodeResponseBlock({
        type: "reasoning",
        reasoning: "reasoning chain",
      });
      expect(result).toEqual({
        type: "thinking",
        thinking: "reasoning chain",
      });
    });

    it("also accepts 'thinking' block type", () => {
      const result = decoder.decodeResponseBlock({
        type: "thinking",
        thinking: "thought",
      });
      expect(result).toEqual({
        type: "thinking",
        thinking: "thought",
      });
    });

    it("returns null for unrelated blocks", () => {
      expect(decoder.decodeResponseBlock({ type: "text", text: "hi" })).toBeNull();
    });
  });

  describe("encodeForRequest", () => {
    it("encodes thinking block without signature", () => {
      const result = decoder.encodeForRequest({
        type: "thinking",
        thinking: "thought",
      });
      expect(result).toEqual({ type: "thinking", thinking: "thought" });
    });

    it("encodes redacted_thinking", () => {
      const result = decoder.encodeForRequest({
        type: "redacted_thinking",
        data: "blob",
      });
      expect(result).toEqual({ type: "redacted_thinking", data: "blob" });
    });
  });
});
