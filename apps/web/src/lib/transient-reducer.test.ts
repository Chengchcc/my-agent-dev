import { describe, expect, test } from "bun:test";
import {
  completeTool,
  type LiveToolMap,
  markTransientError,
  pushTransientNotice,
  upsertTool,
} from "./transient-reducer";

describe("markTransientError", () => {
  test("attaches the error to an existing run, keeping its text", () => {
    const state = { r1: { text: "partial", thinking: "t", agentId: "m1" } };
    const next = markTransientError(state, "r1", "m1", "spawn ENOENT");
    expect(next.r1).toEqual({
      text: "partial",
      thinking: "t",
      agentId: "m1",
      error: "spawn ENOENT",
    });
  });

  test("creates an empty bubble for a run that failed before any text", () => {
    const next = markTransientError({}, "r2", "m1", "catalog down");
    expect(next.r2).toEqual({ text: "", thinking: "", agentId: "m1", error: "catalog down" });
  });
});

describe("pushTransientNotice", () => {
  test("creates a bubble with the notice and keeps later text appends working", () => {
    const next = pushTransientNotice({}, "r1", "m1", 'stream rule "x" matched');
    expect(next.r1?.notices).toEqual(['stream rule "x" matched']);
  });

  test("caps at 5 notices per run", () => {
    let state = {};
    for (let i = 0; i < 8; i++) state = pushTransientNotice(state, "r1", "m1", `n${i}`);
    expect(state.r1?.notices).toEqual(["n3", "n4", "n5", "n6", "n7"]);
  });
});

describe("injected tool display (native_tool_* events -> LiveToolMap)", () => {
  test("upsertTool then completeTool renders a finished tool card entry", () => {
    let state: LiveToolMap = {};
    // toolStarted handler payload (native_tool_started SSE event)
    state = upsertTool(state, {
      runId: "r-1",
      callId: "call-1",
      name: "todo_write",
      state: "running",
    });
    expect(state["r-1:call-1"]).toMatchObject({ name: "todo_write", state: "running" });

    // toolCompleted handler payload (native_tool_completed)
    state = completeTool(state, "r-1", "call-1", { content: "ok" }, false);
    expect(state["r-1:call-1"]).toMatchObject({ state: "done", result: { content: "ok" } });
  });

  test("multiple injected tools (history_recent + todo_write) coexist per callId", () => {
    let state: LiveToolMap = {};
    state = upsertTool(state, {
      runId: "r-1",
      callId: "c-a",
      name: "history_recent",
      state: "running",
    });
    state = upsertTool(state, {
      runId: "r-1",
      callId: "c-b",
      name: "todo_write",
      state: "running",
    });
    expect(Object.keys(state).sort()).toEqual(["r-1:c-a", "r-1:c-b"]);
    expect(state["r-1:c-a"]?.name).toBe("history_recent");
    expect(state["r-1:c-b"]?.name).toBe("todo_write");
  });
});
