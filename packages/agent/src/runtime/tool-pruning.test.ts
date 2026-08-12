import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/message";
import { pruneOldToolResults } from "./tool-pruning.js";

/** Build a tool message with tool_result content. */
function toolMsg(content: string, toolUseId: string): Message {
  return {
    role: "tool",
    text: content,
    blocks: [{ type: "tool_result", tool_use_id: toolUseId, content }],
  };
}

/** Build an assistant message with tool_use. */
function assistantWithToolUse(_id: string, toolName: string, toolUseId: string): Message {
  return {
    role: "assistant",
    blocks: [{ type: "tool_use", id: toolUseId, name: toolName, input: {} }],
  };
}

describe("pruneOldToolResults", () => {
  test("prunes old tool results outside protect window", () => {
    const bigContent = "x".repeat(4_000);
    const msgs: Message[] = [
      assistantWithToolUse("a1", "bash", "tu1"),
      toolMsg(bigContent, "tu1"),
      assistantWithToolUse("a2", "bash", "tu2"),
      toolMsg(bigContent, "tu2"),
      assistantWithToolUse("a3", "bash", "tu3"),
      toolMsg(bigContent, "tu3"),
    ];

    const { messages, savedTokens } = pruneOldToolResults(msgs, {
      protectTokens: 1_000,
      minimumSavings: 100,
    });

    // Two oldest tool results (tu1, tu2) should be pruned; tu3 stays.
    expect(savedTokens).toBeGreaterThan(0);
    const t1 = messages[1]!;
    const t2 = messages[3]!;
    const t3 = messages[5]!;
    expect(t1.text?.startsWith("[pruned:")).toBe(true);
    expect(t2.text?.startsWith("[pruned:")).toBe(true);
    expect(t3.text?.startsWith("[pruned:")).toBe(false);
  });

  test("protected tools are never pruned", () => {
    const bigContent = "x".repeat(4_000);
    const msgs: Message[] = [
      assistantWithToolUse("a1", "read", "tu1"),
      toolMsg(bigContent, "tu1"),
      assistantWithToolUse("a2", "bash", "tu2"),
      toolMsg(bigContent, "tu2"),
    ];

    const { messages, savedTokens } = pruneOldToolResults(msgs, {
      protectTokens: 100,
      minimumSavings: 100,
      protectedTools: new Set(["read"]),
    });

    // read is protected → never pruned; bash is pruned.
    expect(savedTokens).toBeGreaterThan(0);
    expect(messages[1]!.text?.startsWith("[pruned:")).toBe(false);
    expect(messages[3]!.text?.startsWith("[pruned:")).toBe(true);
  });

  test("skips tiny savings below minimumSavings threshold", () => {
    const smallContent = "x".repeat(50);
    const msgs: Message[] = [
      assistantWithToolUse("a1", "bash", "tu1"),
      toolMsg(smallContent, "tu1"),
      assistantWithToolUse("a2", "bash", "tu2"),
      toolMsg(smallContent, "tu2"),
    ];

    const { savedTokens } = pruneOldToolResults(msgs, {
      protectTokens: 10,
      minimumSavings: 500,
    });

    expect(savedTokens).toBe(0);
  });

  test("no tool messages → unchanged", () => {
    const msgs: Message[] = [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ];
    const { messages, savedTokens } = pruneOldToolResults(msgs);
    expect(messages).toEqual(msgs);
    expect(savedTokens).toBe(0);
  });
});
