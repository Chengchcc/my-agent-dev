import { describe, expect, test } from "bun:test";
import {
  appendThinking,
  appendTransient,
  clearRunTodos,
  clearRunTools,
  completeTool,
  type LiveToolMap,
  type RunTodoMap,
  removeTransient,
  setRunTodos,
  type TransientMap,
  upsertTool,
} from "@/lib/transient-reducer";

describe("transient reducer — text", () => {
  test("A delta + B delta → two independent bubbles", () => {
    let s: TransientMap = {};
    s = appendTransient(s, "run-a", "member-a", "hello from A");
    s = appendTransient(s, "run-b", "member-b", "hello from B");
    expect(s["run-a"]).toEqual({
      text: "hello from A",
      thinking: "",
      ordered: [{ type: "text", text: "hello from A" }],
      agentId: "member-a",
    });
    expect(s["run-b"]).toEqual({
      text: "hello from B",
      thinking: "",
      ordered: [{ type: "text", text: "hello from B" }],
      agentId: "member-b",
    });
  });

  test("A delta + A delta → concatenated into A only", () => {
    let s: TransientMap = {};
    s = appendTransient(s, "run-a", "member-a", "one ");
    s = appendTransient(s, "run-b", "member-b", "B");
    s = appendTransient(s, "run-a", "member-a", "two");
    expect(s["run-a"]?.text).toBe("one two");
    expect(s["run-b"]?.text).toBe("B");
  });

  test("canonical A removes only A", () => {
    let s: TransientMap = {};
    s = appendTransient(s, "run-a", "m-a", "A");
    s = appendTransient(s, "run-b", "m-b", "B");
    s = removeTransient(s, "run-a");
    expect(s["run-a"]).toBeUndefined();
    expect(s["run-b"]?.text).toBe("B");
  });

  test("thinking accumulates independently of text", () => {
    let s: TransientMap = {};
    s = appendThinking(s, "run-a", "m-a", "think one ");
    s = appendThinking(s, "run-a", "m-a", "think two");
    s = appendTransient(s, "run-a", "m-a", "text");
    expect(s["run-a"]?.thinking).toBe("think one think two");
    expect(s["run-a"]?.text).toBe("text");
  });

  test("failed B removes only B", () => {
    let s: TransientMap = {};
    s = appendTransient(s, "run-a", "m-a", "A");
    s = appendTransient(s, "run-b", "m-b", "B");
    s = removeTransient(s, "run-b");
    expect(s["run-a"]?.text).toBe("A");
    expect(s["run-b"]).toBeUndefined();
  });

  test("removing an absent run is a no-op (same reference)", () => {
    const s: TransientMap = {};
    expect(removeTransient(s, "nope")).toBe(s);
  });
});

describe("transient reducer — tools", () => {
  test("tool started → running", () => {
    let s: LiveToolMap = {};
    s = upsertTool(s, {
      runId: "r1",
      callId: "c1",
      name: "ls",
      kind: "native",
      state: "running",
    });
    expect(s["r1:c1"]).toMatchObject({ name: "ls", state: "running" });
  });

  test("tool completed → done with result", () => {
    let s: LiveToolMap = {};
    s = upsertTool(s, { runId: "r1", callId: "c1", name: "ls", kind: "native", state: "running" });
    s = completeTool(s, "r1", "c1", { entries: [] }, false);
    expect(s["r1:c1"]?.state).toBe("done");
    expect(s["r1:c1"]?.result).toEqual({ entries: [] });
  });

  test("tool error → error state", () => {
    let s: LiveToolMap = {};
    s = upsertTool(s, {
      runId: "r1",
      callId: "c1",
      name: "bash",
      kind: "native",
      state: "running",
    });
    s = completeTool(s, "r1", "c1", { error: "boom" }, true);
    expect(s["r1:c1"]?.state).toBe("error");
  });

  test("complete on unknown call is a no-op", () => {
    expect(completeTool({}, "r1", "ghost", {}, false)).toEqual({});
  });

  test("run ended clears only that run's tools", () => {
    let s: LiveToolMap = {};
    s = upsertTool(s, { runId: "r1", callId: "c1", name: "ls", kind: "native", state: "running" });
    s = upsertTool(s, {
      runId: "r2",
      callId: "c2",
      name: "read",
      kind: "native",
      state: "running",
    });
    s = clearRunTools(s, "r1");
    expect(s["r1:c1"]).toBeUndefined();
    expect(s["r2:c2"]).toBeDefined();
  });
});

describe("transient reducer — todos", () => {
  test("todo update replaces the full snapshot", () => {
    let s: RunTodoMap = {};
    s = setRunTodos(s, "r1", [{ id: "a", text: "step 1", status: "done" }]);
    s = setRunTodos(s, "r1", [
      { id: "a", text: "step 1", status: "done" },
      { id: "b", text: "step 2", status: "pending" },
    ]);
    expect(s.r1).toHaveLength(2);
  });

  test("run failed clears text/tools/todo via their per-run removers", () => {
    let t: TransientMap = {};
    let tools: LiveToolMap = {};
    let todos: RunTodoMap = {};
    t = appendTransient(t, "r1", "m", "partial");
    tools = upsertTool(tools, {
      runId: "r1",
      callId: "c1",
      name: "ls",
      kind: "native",
      state: "running",
    });
    todos = setRunTodos(todos, "r1", [{ id: "a", text: "x", status: "pending" }]);
    t = removeTransient(t, "r1");
    tools = clearRunTools(tools, "r1");
    todos = clearRunTodos(todos, "r1");
    expect(t).toEqual({});
    expect(tools).toEqual({});
    expect(todos).toEqual({});
  });

  test("run completed keeps text but clears tools/todo", () => {
    let t: TransientMap = {};
    let tools: LiveToolMap = {};
    let todos: RunTodoMap = {};
    t = appendTransient(t, "r1", "m", "final text");
    tools = upsertTool(tools, {
      runId: "r1",
      callId: "c1",
      name: "ls",
      kind: "native",
      state: "done",
    });
    todos = setRunTodos(todos, "r1", [{ id: "a", text: "x", status: "done" }]);
    tools = clearRunTools(tools, "r1");
    todos = clearRunTodos(todos, "r1");
    expect(t.r1?.text).toBe("final text");
    expect(tools).toEqual({});
    expect(todos).toEqual({});
  });
});
