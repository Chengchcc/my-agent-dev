import { describe, it, expect } from "bun:test";
import type { ContentBlock, Message, LLMResponseChunk } from "../../src/types";
import { flattenBlocks, synthesizeBlocksFromLegacy } from "../../src/types";

describe("ContentBlock types", () => {
  it("LLMResponseChunk accepts optional thinking fields", () => {
    const chunk: LLMResponseChunk = {
      content: "hello",
      thinking: "hmm...",
      thinkingSignature: "sig123",
      done: false,
    };
    expect(chunk.content).toBe("hello");
    expect(chunk.thinking).toBe("hmm...");
    expect(chunk.thinkingSignature).toBe("sig123");
  });

  it("LLMResponseChunk works without thinking fields (backward compat)", () => {
    const chunk: LLMResponseChunk = {
      content: "plain text",
      done: true,
    };
    expect(chunk.content).toBe("plain text");
    expect(chunk.done).toBe(true);
    expect(chunk.thinking).toBeUndefined();
  });
});

describe("flattenBlocks", () => {
  it("extracts text from mixed blocks, ignoring thinking", () => {
    const blocks: ContentBlock[] = [
      { type: "thinking", thinking: "let me think...", signature: "sig" },
      { type: "text", text: "Hello!" },
      { type: "text", text: " World" },
    ];
    expect(flattenBlocks(blocks)).toBe("Hello! World");
  });

  it("returns empty string when no text blocks", () => {
    const blocks: ContentBlock[] = [
      { type: "thinking", thinking: "thinking only" },
      { type: "redacted_thinking", data: "encrypted" },
    ];
    expect(flattenBlocks(blocks)).toBe("");
  });
});

describe("synthesizeBlocksFromLegacy", () => {
  it("converts text-only message to blocks with single text block", () => {
    const msg: Message = {
      role: "assistant",
      content: "Hello world",
    };
    const blocks = synthesizeBlocksFromLegacy(msg);
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toEqual({ type: "text", text: "Hello world" });
  });

  it("converts message with tool_calls to mixed blocks", () => {
    const msg: Message = {
      role: "assistant",
      content: "Let me check that.",
      tool_calls: [
        { id: "tc1", name: "read", arguments: { path: "/x" } },
      ],
    };
    const blocks = synthesizeBlocksFromLegacy(msg);
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toEqual({ type: "text", text: "Let me check that." });
    expect(blocks[1]).toEqual({
      type: "tool_use",
      id: "tc1",
      name: "read",
      input: { path: "/x" },
    });
  });
});

describe("round-trip", () => {
  it("legacy message -> blocks -> flatten equals original content", () => {
    const msg: Message = {
      role: "assistant",
      content: "Hello world",
    };
    const blocks = synthesizeBlocksFromLegacy(msg);
    expect(flattenBlocks(blocks)).toBe(msg.content);
  });
});
