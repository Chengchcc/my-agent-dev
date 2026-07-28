import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/message";
import { consoleLogger } from "../runtime/logger.js";
import { passthroughContextManager } from "./passthrough.js";

const ctx = {
  sessionId: "t1",
  logger: consoleLogger({ level: "silent" }),
  model: { stream: async function* () {} },
};

describe("passthroughContextManager", () => {
  test("returns new array with same elements", async () => {
    const msgs: Message[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ];

    const result = await passthroughContextManager().shape(ctx, msgs);

    expect(result).toEqual(msgs);
    expect(result).not.toBe(msgs);
  });

  test("does not mutate input", async () => {
    const msgs: Message[] = [{ role: "user", text: "hi" }];
    const original = [...msgs];

    await passthroughContextManager().shape(ctx, msgs);

    expect(msgs).toEqual(original);
  });
});
