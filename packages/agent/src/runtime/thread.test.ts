import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/message";
import { createThread } from "./thread.js";

describe("createThread", () => {
  test("creates a thread with id and empty messages", () => {
    const thread = createThread();

    expect(typeof thread.id).toBe("string");
    expect(thread.id.length).toBeGreaterThan(0);
    expect(thread.messages).toEqual([]);
  });

  test("accepts initial messages", () => {
    const messages: Message[] = [{ role: "user", text: "hi" }];
    const thread = createThread(messages);

    expect(thread.messages).toEqual(messages);
  });
});
