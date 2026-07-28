import { describe, expect, test } from "bun:test";
import type { ChatModel } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import { consoleLogger } from "../runtime/logger.js";
import { autoSummarize } from "./summarizing.js";

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

describe("summarizingContextManager", () => {
  test("passes through when under trigger", async () => {
    const messages = msgs(3);
    const result = await autoSummarize({
      triggerAt: 1_000_000,
      keepRecent: 2,
      countTokens: () => 100,
    }).shape(ctx, messages);

    expect(result).toEqual(messages);
  });

  test("calls custom summarizer when over trigger", async () => {
    const messages = msgs(20);
    let summarizerCalled = false;

    const result = await autoSummarize({
      triggerAt: 10,
      keepRecent: 2,
      summarizer: async (old) => {
        summarizerCalled = true;
        return { role: "user", text: `[Summary of ${old.length} msgs]` };
      },
      countTokens: () => 1000,
    }).shape(ctx, messages);

    expect(summarizerCalled).toBe(true);
    // result should have: summary + last 2 messages (keepRecent=2)
    expect(result[0]?.text).toContain("[Summary");
    expect(result.length).toBe(3);
  });

  test("empty old → passes through even when over trigger", async () => {
    const messages = msgs(2);
    const result = await autoSummarize({
      triggerAt: 1,
      keepRecent: 10,
      countTokens: () => 1000,
    }).shape(ctx, messages);

    // keepRecent=10 covers all messages, old is empty → passthrough
    expect(result).toEqual(messages);
  });

  test("tier 2: uses summarizerModel with built-in prompt", async () => {
    const messages = msgs(20);
    const modelUsed: { streamCalled: boolean } = { streamCalled: false };

    const customModel = {
      stream: async function* () {
        modelUsed.streamCalled = true;
        yield { done: true, stopReason: "end_turn" as const };
      },
    };

    await autoSummarize({
      triggerAt: 10,
      keepRecent: 2,
      summarizerModel: customModel,
      countTokens: () => 1000,
    }).shape(ctx, messages);

    expect(modelUsed.streamCalled).toBe(true);
  });

  test("tier 3: uses ctx.model when no summarizer or summarizerModel", async () => {
    const messages = msgs(20);
    const called = { value: false };

    const ctxWithModel = {
      ...ctx,
      model: {
        stream: async function* () {
          called.value = true;
          yield { done: true, stopReason: "end_turn" as const };
        },
      },
    };

    await autoSummarize({
      triggerAt: 10,
      keepRecent: 2,
      countTokens: () => 1000,
    }).shape(ctxWithModel, messages);

    expect(called.value).toBe(true);
  });
});

import { structuredSummarize } from "./summarizing.js";

describe("structuredSummarize", () => {
  test("returns a message with structured summary content", async () => {
    let capturedMsgs: Message[] = [];
    const model = {
      id: "test",
      stream: async function* (msgs: Message[]) {
        capturedMsgs = msgs;
        yield {
          delta: {
            type: "text",
            text: "## Goal\ntest goal\n\n## Progress\n\n### Done\n- [x] completed A\n\n### In Progress\n- [ ] doing B",
          },
          usage: { input: 10, output: 20 },
        };
        yield { delta: {}, stopReason: "end_turn", done: true };
      },
      countTokens: async () => 0,
    };

    const old: Message[] = [
      { role: "user", text: "do something" },
      { role: "assistant", text: "ok doing it" },
    ];

    const result = await structuredSummarize(old, model as unknown as ChatModel);

    expect(result.role).toBe("user");
    expect(result.text).toContain("[Earlier conversation summary]");
    expect(result.text).toContain("## Goal");
    expect(result.text).toContain("test goal");
    expect(capturedMsgs.length).toBeGreaterThan(old.length);
    const lastMsg = capturedMsgs[capturedMsgs.length - 1];
    expect(lastMsg?.text).toContain("You MUST summarize");
  });

  test("tolerates missing sections in model output", async () => {
    const model = {
      id: "test",
      stream: async function* () {
        yield {
          delta: { type: "text", text: "just a freeform summary, no structure" },
          usage: { input: 5, output: 10 },
        };
        yield { delta: {}, stopReason: "end_turn", done: true };
      },
      countTokens: async () => 0,
    };

    const old: Message[] = [{ role: "user", text: "hi" }];
    const result = await structuredSummarize(old, model as unknown as ChatModel);

    expect(result.role).toBe("user");
    expect(result.text).toContain("[Earlier conversation summary]");
  });
});

describe("defaultSummarize", () => {
  test("is exported and produces a summary message", async () => {
    const { defaultSummarize } = await import("./summarizing.js");
    const model = {
      id: "test",
      stream: async function* () {
        yield {
          delta: { type: "text", text: "The user said hi and the assistant replied." },
          usage: { input: 5, output: 10 },
        };
        yield { delta: {}, stopReason: "end_turn", done: true };
      },
      countTokens: async () => 0,
    };

    const old: Message[] = [{ role: "user", text: "hi" }];
    const result = await defaultSummarize(old, model as unknown as ChatModel);

    expect(result.role).toBe("user");
    expect(result.text).toContain("[Earlier conversation summary]");
  });
});
