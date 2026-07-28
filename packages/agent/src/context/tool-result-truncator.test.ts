import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/message";
import { consoleLogger } from "../runtime/logger.js";
import { toolResultTruncator } from "./tool-result-truncator.js";

const ctx = {
  sessionId: "t1",
  logger: consoleLogger({ level: "silent" }),
  model: { stream: async function* () {} },
};

describe("toolResultTruncator", () => {
  test("truncates long tool_result content with marker", async () => {
    const msgs: Message[] = [
      {
        role: "user",
        blocks: [{ type: "tool_result", tool_use_id: "t1", content: "a".repeat(200) }],
      },
    ];

    const result = await toolResultTruncator({ maxCharsPerResult: 100 }).shape(ctx, msgs);
    const block = (result[0]?.blocks as { type: string; content: string }[])[0]!;
    expect(block.content.length).toBeLessThan(200);
    expect(block.content).toContain("[truncated");
    expect(block.content).toContain("100 chars");
  });

  test("short content unchanged", async () => {
    const msgs: Message[] = [
      {
        role: "user",
        blocks: [{ type: "tool_result", tool_use_id: "t1", content: "short" }],
      },
    ];

    const result = await toolResultTruncator({ maxCharsPerResult: 100 }).shape(ctx, msgs);
    expect(result).toEqual(msgs);
    expect(result).not.toBe(msgs); // new array
  });

  test("non-tool_result blocks unchanged", async () => {
    const msgs: Message[] = [
      {
        role: "user",
        blocks: [
          { type: "tool_use", id: "t1", name: "read", input: {} },
          { type: "tool_result", tool_use_id: "t1", content: "short" },
        ],
      },
    ];

    const result = await toolResultTruncator({ maxCharsPerResult: 10 }).shape(ctx, msgs);
    const blocks = result[0]?.blocks as { type: string }[];
    expect(blocks[0]?.type).toBe("tool_use");
    expect(blocks[1]?.type).toBe("tool_result");
  });

  test("string content messages unchanged", async () => {
    const msgs: Message[] = [{ role: "assistant", text: "hello world" }];

    const result = await toolResultTruncator({ maxCharsPerResult: 10 }).shape(ctx, msgs);
    expect(result).toEqual(msgs);
  });
});
