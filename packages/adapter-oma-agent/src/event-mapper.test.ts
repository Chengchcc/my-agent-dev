import { describe, expect, test } from "bun:test";
import { mapRunEvent } from "./event-mapper.js";

describe("tool event mapping (injected tools reach the web as native_tool_*)", () => {
  test("tool_execution_start with an injected tool name maps to native_tool_started", () => {
    const ev = mapRunEvent({
      id: 1,
      type: "tool_execution_start",
      data: { toolName: "todo_write", callId: "call-1" },
    } as never);
    expect(ev).toEqual({ type: "native_tool_started", toolName: "todo_write", callId: "call-1" });
  });

  test("tool_execution_end carries the result for the web tool card", () => {
    const ev = mapRunEvent({
      id: 2,
      type: "tool_execution_end",
      data: { toolName: "history_recent", callId: "call-2", result: { content: "[]" } },
    } as never);
    expect(ev).toEqual({
      type: "native_tool_completed",
      toolName: "history_recent",
      callId: "call-2",
      result: { content: "[]" },
    });
  });
});
