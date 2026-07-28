import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/message";
import { consoleLogger } from "../runtime/logger.js";
import { slidingWindowContextManager } from "./sliding-window.js";

const ctx = {
  sessionId: "t1",
  logger: consoleLogger({ level: "silent" }),
  model: { stream: async function* () {} },
};

describe("slidingWindowContextManager", () => {
  test("keeps last N turns", async () => {
    const msgs: Message[] = [
      { role: "user", text: "u1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "u2" },
      { role: "assistant", text: "a2" },
      { role: "user", text: "u3" },
      { role: "assistant", text: "a3" },
    ];

    const result = await slidingWindowContextManager({ maxTurns: 2 }).shape(ctx, msgs);
    expect(result).toEqual([
      { role: "user", text: "u2" },
      { role: "assistant", text: "a2" },
      { role: "user", text: "u3" },
      { role: "assistant", text: "a3" },
    ]);
  });

  test("keepFirst preserves prefix", async () => {
    const msgs: Message[] = [
      { role: "system", text: "sys" },
      { role: "user", text: "u1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "u2" },
      { role: "assistant", text: "a2" },
    ];

    const result = await slidingWindowContextManager({ maxTurns: 1, keepFirst: 1 }).shape(
      ctx,
      msgs,
    );
    expect(result).toEqual([
      { role: "system", text: "sys" },
      { role: "user", text: "u2" },
      { role: "assistant", text: "a2" },
    ]);
  });

  test("under limit → all preserved", async () => {
    const msgs: Message[] = [
      { role: "user", text: "u1" },
      { role: "assistant", text: "a1" },
    ];

    const result = await slidingWindowContextManager({ maxTurns: 5 }).shape(ctx, msgs);
    expect(result).toEqual(msgs);
  });

  test("does not mutate input", async () => {
    const msgs: Message[] = [
      { role: "user", text: "u1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "u2" },
    ];
    const original = JSON.stringify(msgs);

    await slidingWindowContextManager({ maxTurns: 1 }).shape(ctx, msgs);
    expect(JSON.stringify(msgs)).toBe(original);
  });

  test("empty messages → empty result", async () => {
    const result = await slidingWindowContextManager({ maxTurns: 1 }).shape(ctx, []);
    expect(result).toEqual([]);
  });

  test("pairing-aware: dropping a turn with tool_use drops associated tool_result", async () => {
    const msgs: Message[] = [
      { role: "user", text: "u1" },
      {
        role: "assistant",
        blocks: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
      },
      {
        role: "user",
        blocks: [{ type: "tool_result", tool_use_id: "t1", content: "file content" }],
      },
      { role: "user", text: "u2" },
      { role: "assistant", text: "a2" },
    ];

    const result = await slidingWindowContextManager({ maxTurns: 1 }).shape(ctx, msgs);

    // Only u2 + a2 should remain; u1 + tool_use + tool_result should be dropped together
    expect(result).toEqual([
      { role: "user", text: "u2" },
      { role: "assistant", text: "a2" },
    ]);
  });
});
