import { describe, expect, test } from "bun:test";
import { MessageParseError, parseMessageRevision, serializeMessageRevision } from "./parser.js";
import type { MessageRevision } from "./revision.js";

const VALID_REVISION: MessageRevision = {
  messageId: "run:r1:assistant:0",
  state: "streaming",
  role: "assistant",
  text: "hello",
  updatedAt: 1000,
};

describe("parseMessageRevision", () => {
  test("parses valid revision", () => {
    const result = parseMessageRevision(VALID_REVISION);
    expect(result.messageId).toBe("run:r1:assistant:0");
    expect(result.state).toBe("streaming");
    expect(result.role).toBe("assistant");
    expect(result.text).toBe("hello");
  });

  test("fails on non-object input (string)", () => {
    expect(() => parseMessageRevision("legacy string")).toThrow(MessageParseError);
  });

  test("fails on non-object input (array)", () => {
    expect(() => parseMessageRevision([{ type: "text", text: "old" }])).toThrow(MessageParseError);
  });

  test("fails on missing messageId", () => {
    expect(() =>
      parseMessageRevision({ state: "done", role: "assistant", updatedAt: 1000 }),
    ).toThrow(MessageParseError);
    try {
      parseMessageRevision({ state: "done", role: "assistant", updatedAt: 1000 });
    } catch (e) {
      expect((e as MessageParseError).field).toBe("messageId");
    }
  });

  test("fails on missing state", () => {
    expect(() =>
      parseMessageRevision({ messageId: "m1", role: "assistant", updatedAt: 1000 }),
    ).toThrow(MessageParseError);
  });

  test("fails on missing role", () => {
    expect(() => parseMessageRevision({ messageId: "m1", state: "done", updatedAt: 1000 })).toThrow(
      MessageParseError,
    );
  });

  test("fails on missing updatedAt", () => {
    expect(() =>
      parseMessageRevision({ messageId: "m1", state: "done", role: "assistant" }),
    ).toThrow(MessageParseError);
  });

  test("fails on invalid state value", () => {
    expect(() =>
      parseMessageRevision({
        messageId: "m1",
        state: "unknown",
        role: "assistant",
        updatedAt: 1000,
      }),
    ).toThrow(MessageParseError);
  });

  test("fails on invalid role value", () => {
    expect(() =>
      parseMessageRevision({
        messageId: "m1",
        state: "done",
        role: "bot",
        updatedAt: 1000,
      }),
    ).toThrow(MessageParseError);
  });

  test("fails on empty messageId", () => {
    expect(() =>
      parseMessageRevision({
        messageId: "",
        state: "done",
        role: "assistant",
        updatedAt: 1000,
      }),
    ).toThrow(MessageParseError);
  });

  // ── Legacy shape rejection ──

  test("fails on old { text } shape (no messageId/state)", () => {
    expect(() => parseMessageRevision({ text: "legacy" })).toThrow(MessageParseError);
  });

  test("fails on old { text, conversationId } shape", () => {
    expect(() => parseMessageRevision({ text: "legacy", conversationId: "c1" })).toThrow(
      MessageParseError,
    );
  });

  test("fails on old blocks-only shape", () => {
    expect(() =>
      parseMessageRevision({
        blocks: [{ type: "text", text: "x" }],
        conversationId: "c1",
      }),
    ).toThrow(MessageParseError);
  });

  test("fails on null input", () => {
    expect(() => parseMessageRevision(null)).toThrow(MessageParseError);
  });

  test("fails on undefined input", () => {
    expect(() => parseMessageRevision(undefined)).toThrow(MessageParseError);
  });

  test("parses revision with tools and blocks", () => {
    const rev = {
      messageId: "run:r2:assistant:0",
      state: "waiting" as const,
      role: "assistant" as const,
      blocks: [{ type: "tool_use" as const, id: "t1", name: "bash", input: {} }],
      tools: [{ id: "t1", name: "bash", state: "running" as const }],
      updatedAt: 2000,
    };
    const result = parseMessageRevision(rev);
    expect(result.tools).toHaveLength(1);
    expect(result.blocks).toHaveLength(1);
    expect(result.state).toBe("waiting");
  });
});

describe("serializeMessageRevision", () => {
  test("round-trips through JSON", () => {
    const serialized = serializeMessageRevision(VALID_REVISION);
    const parsed = JSON.parse(serialized);
    const reparsed = parseMessageRevision(parsed);
    expect(reparsed.messageId).toBe(VALID_REVISION.messageId);
    expect(reparsed.state).toBe(VALID_REVISION.state);
  });
});
