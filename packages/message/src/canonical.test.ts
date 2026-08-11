import { describe, expect, test } from "bun:test";
import { normalizeCanonicalMessages } from "./canonical.js";
import type { Message } from "./message.js";

describe("normalizeCanonicalMessages", () => {
  test("splits a mixed assistant message into assistant + tool result message", () => {
    const input: Message[] = [
      {
        role: "assistant",
        text: "final answer",
        blocks: [
          { type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } },
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
        ],
      },
    ];
    const out = normalizeCanonicalMessages(input);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      role: "assistant",
      text: "final answer",
      blocks: [{ type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } }],
    });
    expect(out[1]).toEqual({
      role: "tool",
      blocks: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    });
  });

  test("keeps text blocks in the assistant message alongside tool_use", () => {
    const input: Message[] = [
      {
        role: "assistant",
        text: "working",
        blocks: [
          { type: "text", text: "working" },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
          { type: "tool_result", tool_use_id: "t1", content: "a\nb" },
        ],
      },
    ];
    const out = normalizeCanonicalMessages(input);
    expect(out[0]?.blocks).toEqual([
      { type: "text", text: "working" },
      { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
    ]);
    expect(out[1]?.role).toBe("tool");
  });

  test("drops tool_result blocks with no matching tool_use id", () => {
    const input: Message[] = [
      {
        role: "assistant",
        text: "answer",
        blocks: [
          { type: "tool_use", id: "t1", name: "read", input: {} },
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
          { type: "tool_result", tool_use_id: "t2", content: "orphan" },
        ],
      },
    ];
    const out = normalizeCanonicalMessages(input);
    expect(out).toHaveLength(2);
    expect(out[1]?.blocks).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]);
  });

  test("drops a tool_result-only assistant message when results are unpaired", () => {
    const input: Message[] = [
      {
        role: "assistant",
        text: "",
        blocks: [{ type: "tool_result", tool_use_id: "x", content: "orphan" }],
      },
    ];
    const out = normalizeCanonicalMessages(input);
    expect(out).toHaveLength(0);
  });

  test("passes canonical messages through unchanged", () => {
    const input: Message[] = [
      { role: "user", text: "hi" },
      { role: "assistant", blocks: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "tool", blocks: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "assistant", text: "done" },
    ];
    const out = normalizeCanonicalMessages(input);
    expect(out).toEqual(input);
  });

  test("leaves user messages with tool_result blocks untouched", () => {
    const input: Message[] = [
      { role: "user", blocks: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ];
    expect(normalizeCanonicalMessages(input)).toEqual(input);
  });
});
