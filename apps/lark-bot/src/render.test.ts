import { describe, expect, test } from "bun:test";
import type { MessageRevision } from "@chengchenccc/message";
import { renderRevision } from "./render.js";

function makeRevision(overrides: Partial<MessageRevision> = {}): MessageRevision {
  return {
    messageId: "msg:test:1",
    role: "assistant",
    state: "done",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("renderRevision", () => {
  test("renders text field", () => {
    expect(renderRevision(makeRevision({ text: "hello world" }))).toBe("hello world");
  });

  test("renders blocks — joined text blocks", () => {
    expect(
      renderRevision(
        makeRevision({
          blocks: [
            { type: "text", text: "Hello " },
            { type: "text", text: "World" },
            { type: "tool_use", id: "t1", name: "read", input: {} },
          ],
        }),
      ),
    ).toBe("Hello World");
  });

  test("renders blocks with no text blocks — fallback", () => {
    expect(
      renderRevision(
        makeRevision({
          blocks: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
        }),
      ),
    ).toBe("[Unsupported content]");
  });

  test("empty revision — fallback", () => {
    expect(renderRevision(makeRevision())).toBe("[Unsupported content]");
  });
});
