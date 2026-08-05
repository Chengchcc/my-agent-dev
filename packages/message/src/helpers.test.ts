import { describe, expect, test } from "bun:test";
import {
  assistantMessageId,
  isOpenMessageState,
  isTerminalMessageState,
  mergeMessageRevision,
} from "./helpers.js";
import type { Message } from "./message.js";
import type { MessageRevision } from "./revision.js";

describe("assistantMessageId", () => {
  test("generates id from runId and ordinal", () => {
    expect(assistantMessageId("r1", 0)).toBe("run:r1:assistant:0");
    expect(assistantMessageId("r1", 1)).toBe("run:r1:assistant:1");
  });

  test("same runId + same ordinal is idempotent", () => {
    expect(assistantMessageId("r1", 0)).toBe(assistantMessageId("r1", 0));
  });

  test("different ordinals produce different ids", () => {
    expect(assistantMessageId("r1", 0)).not.toBe(assistantMessageId("r1", 1));
  });
});

describe("isOpenMessageState", () => {
  test("pending/streaming/waiting are open", () => {
    expect(isOpenMessageState("pending")).toBe(true);
    expect(isOpenMessageState("streaming")).toBe(true);
    expect(isOpenMessageState("waiting")).toBe(true);
  });

  test("done/error are not open", () => {
    expect(isOpenMessageState("done")).toBe(false);
    expect(isOpenMessageState("error")).toBe(false);
  });
});

describe("isTerminalMessageState", () => {
  test("done/error are terminal", () => {
    expect(isTerminalMessageState("done")).toBe(true);
    expect(isTerminalMessageState("error")).toBe(true);
  });

  test("pending/streaming/waiting are not terminal", () => {
    expect(isTerminalMessageState("pending")).toBe(false);
    expect(isTerminalMessageState("streaming")).toBe(false);
    expect(isTerminalMessageState("waiting")).toBe(false);
  });
});

describe("mergeMessageRevision", () => {
  test("creates new Message from revision when base is null", () => {
    const rev: MessageRevision = {
      messageId: "run:r1:assistant:0",
      state: "streaming",
      role: "assistant",
      text: "hello",
      updatedAt: 1000,
    };
    const msg = mergeMessageRevision(null, rev);
    expect(msg.id).toBe("run:r1:assistant:0");
    expect(msg.state).toBe("streaming");
    expect(msg.text).toBe("hello");
    expect(msg.createdAt).toBe(1000);
  });

  test("upserts by messageId — updates existing message", () => {
    const existing: Message = {
      id: "run:r1:assistant:0",
      role: "assistant",
      state: "streaming",
      text: "partial...",
      createdAt: 1000,
    };
    const rev: MessageRevision = {
      messageId: "run:r1:assistant:0",
      state: "done",
      role: "assistant",
      text: "complete",
      updatedAt: 2000,
    };
    const msg = mergeMessageRevision(existing, rev);
    expect(msg.id).toBe("run:r1:assistant:0");
    expect(msg.state).toBe("done");
    expect(msg.text).toBe("complete");
    expect(msg.updatedAt).toBe(2000);
    expect(msg.createdAt).toBe(1000);
  });

  test("preserves existing fields not in revision", () => {
    const existing: Message = {
      id: "run:r1:assistant:0",
      role: "assistant",
      state: "streaming",
      text: "partial",
      author: { kind: "agent", id: "a1" },
      createdAt: 1000,
    };
    const rev: MessageRevision = {
      messageId: "run:r1:assistant:0",
      state: "done",
      role: "assistant",
      updatedAt: 2000,
    };
    const msg = mergeMessageRevision(existing, rev);
    expect(msg.author).toEqual({ kind: "agent", id: "a1" });
    expect(msg.text).toBe("partial");
  });
});
