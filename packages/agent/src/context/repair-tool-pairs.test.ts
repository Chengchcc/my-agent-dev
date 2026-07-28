import { describe, expect, test } from "bun:test";
import { repairToolPairs } from "../runtime/repair-tool-pairs.js";

describe("repairToolPairs", () => {
  test("passes through clean messages unchanged", () => {
    const msgs = [
      { role: "user" as const, text: "hello" },
      { role: "assistant" as const, text: "hi" },
    ];
    expect(repairToolPairs(msgs)).toEqual(msgs);
  });

  test("keeps paired tool_use + tool_result", () => {
    const msgs = [
      {
        role: "assistant" as const,
        blocks: [{ type: "tool_use" as const, id: "t1", name: "read", input: {} }],
      },
      {
        role: "user" as const,
        blocks: [{ type: "tool_result" as const, tool_use_id: "t1", content: "ok" }],
      },
    ];
    const result = repairToolPairs(msgs);
    expect(result.length).toBe(2);
  });

  test("removes orphan tool_use (no matching tool_result)", () => {
    const msgs = [
      {
        role: "assistant" as const,
        blocks: [{ type: "tool_use" as const, id: "orphan", name: "read", input: {} }],
      },
    ];
    const result = repairToolPairs(msgs);
    // orphan tool_use removed, message now has empty blocks → filtered
    expect(result.length).toBe(0);
  });

  test("removes orphan tool_result (no matching tool_use)", () => {
    const msgs = [
      {
        role: "user" as const,
        blocks: [{ type: "tool_result" as const, tool_use_id: "orphan", content: "ok" }],
      },
    ];
    const result = repairToolPairs(msgs);
    expect(result.length).toBe(0);
  });

  test("removes empty content messages (non-system)", () => {
    const msgs = [
      { role: "user" as const, text: "" },
      { role: "assistant" as const, text: "valid" },
    ];
    const result = repairToolPairs(msgs);
    expect(result.length).toBe(1);
    expect(result[0]?.text).toBe("valid");
  });

  test("preserves system messages even if content is empty", () => {
    const msgs = [
      { role: "system" as const, text: "" },
      { role: "user" as const, text: "hi" },
    ];
    const result = repairToolPairs(msgs);
    expect(result.length).toBe(2);
  });

  test("mixed paired + orphan: keeps paired, drops orphans", () => {
    const msgs = [
      {
        role: "assistant" as const,
        blocks: [
          { type: "tool_use" as const, id: "good", name: "read", input: {} },
          { type: "tool_use" as const, id: "bad", name: "bash", input: {} },
        ],
      },
      {
        role: "user" as const,
        blocks: [{ type: "tool_result" as const, tool_use_id: "good", content: "ok" }],
      },
    ];
    const result = repairToolPairs(msgs);
    expect(result.length).toBe(2);
    const assistantBlocks = result[0]?.blocks;
    expect(Array.isArray(assistantBlocks)).toBe(true);
    const blocks = assistantBlocks as Array<{ id: string }>;
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.id).toBe("good");
  });

  test("string text messages pass through unchanged", () => {
    const msgs = [
      { role: "user" as const, text: "plain text" },
      { role: "assistant" as const, text: "response text" },
    ];
    const result = repairToolPairs(msgs);
    expect(result).toEqual(msgs);
  });
});
