import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/message";
import { consoleLogger } from "../runtime/logger.js";
import { tokenBudgetContextManager } from "./token-budget.js";

const ctx = {
  sessionId: "t1",
  logger: consoleLogger({ level: "silent" }),
  model: { stream: async function* () {} },
};

function msgs(count: number): Message[] {
  const m: Message[] = [];
  for (let i = 0; i < count; i++) {
    m.push({ role: "user", text: `msg-${i}` });
    m.push({ role: "assistant", text: `resp-${i}` });
  }
  return m;
}

describe("tokenBudgetContextManager", () => {
  test("passes through when under budget", async () => {
    const messages = msgs(3);
    const result = await tokenBudgetContextManager({
      maxTokens: 1_000_000,
      countTokens: () => 100,
    }).shape(ctx, messages);

    expect(result).toEqual(messages);
  });

  test("truncates from head when over budget", async () => {
    const messages = msgs(10);
    let _callCount = 0;
    const result = await tokenBudgetContextManager({
      maxTokens: 1000,
      reserveForOutput: 500,
      countTokens: (m) => {
        _callCount++;
        // Each message = 100 tokens; budget = 1000 - 500 = 500
        // That fits 5 messages from tail
        return m.length * 100;
      },
    }).shape(ctx, messages);

    expect(result.length).toBeLessThan(messages.length);
    expect(result.length).toBeGreaterThan(0);
    // last elements preserved (from tail)
    const last = result.at(-1);
    const expectedLast = messages.at(-1);
    if (last && expectedLast) expect(last).toEqual(expectedLast);
  });

  test("falls back to char approximation when no countTokens", async () => {
    const messages = msgs(5);
    const result = await tokenBudgetContextManager({
      maxTokens: 1_000_000,
    }).shape(ctx, messages);

    expect(result).toEqual(messages);
  });

  test("uses custom countTokens over model.countTokens", async () => {
    const customCalled: number[] = [];
    const modelCountCalled: number[] = [];

    const _result = await tokenBudgetContextManager({
      maxTokens: 1_000_000,
      countTokens: (m) => {
        customCalled.push(m.length);
        return 10;
      },
    }).shape(
      {
        ...ctx,
        model: {
          stream: async function* () {},
          countTokens: (m: readonly Message[]) => {
            modelCountCalled.push(m.length);
            return 999;
          },
        },
      },
      msgs(3),
    );

    expect(customCalled.length).toBeGreaterThan(0);
    expect(modelCountCalled.length).toBe(0);
  });

  test("async countTokens works correctly", async () => {
    const messages = msgs(10);
    const result = await tokenBudgetContextManager({
      maxTokens: 1000,
      reserveForOutput: 500,
      countTokens: async (m) => m.length * 100,
    }).shape(ctx, messages);

    expect(result.length).toBeLessThan(messages.length);
    expect(result.length).toBeGreaterThan(0);
    // last message preserved (from tail)
    const last = result.at(-1);
    expect(last).toEqual(messages.at(-1));
  });
});
