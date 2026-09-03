import { describe, expect, test } from "bun:test";
import {
  appendThinking,
  appendTransient,
  clearRunTodos,
  clearRunTools,
  clearTransientApproval,
  completeTool,
  type LiveToolMap,
  markTransientError,
  pushTransientNotice,
  type RunTodoMap,
  removeTransient,
  setRunTodos,
  setTransientApproval,
  type TransientMap,
  toolKey,
  upsertTool,
} from "./transient-reducer";

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

  test("appendTransient/appendThinking record arrival order", () => {
    let state: TransientMap = {};
    state = appendThinking(state, "r1", "ag1", "think one ");
    state = appendTransient(state, "r1", "ag1", "say this ");
    state = appendThinking(state, "r1", "ag1", "think two");
    expect(state.r1?.text).toBe("say this ");
    expect(state.r1?.thinking).toBe("think one think two");
    expect(state.r1?.ordered).toEqual([
      { type: "thinking", text: "think one " },
      { type: "text", text: "say this " },
      { type: "thinking", text: "think two" },
    ]);
  });

  test("only text deltas keep text/thinking split correct", () => {
    let state: TransientMap = {};
    state = appendTransient(state, "r1", "ag1", "a");
    state = appendTransient(state, "r1", "ag1", "b");
    state = appendThinking(state, "r1", "ag1", "x");
    expect(state.r1?.text).toBe("ab");
    expect(state.r1?.thinking).toBe("x");
    expect(state.r1?.ordered?.map((b) => b.type)).toEqual(["text", "text", "thinking"]);
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
      state: "running",
    });
    expect(s["r1:c1"]).toMatchObject({ name: "ls", state: "running" });
  });

  test("tool completed → done with result", () => {
    let s: LiveToolMap = {};
    s = upsertTool(s, { runId: "r1", callId: "c1", name: "ls", state: "running" });
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
    s = upsertTool(s, { runId: "r1", callId: "c1", name: "ls", state: "running" });
    s = upsertTool(s, {
      runId: "r2",
      callId: "c2",
      name: "read",
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

describe("transient reducer — errors and notices", () => {
  test("markTransientError keeps text and attaches error", () => {
    let s: TransientMap = {};
    s = appendTransient(s, "r1", "m", "partial");
    s = markTransientError(s, "r1", "m", "boom");
    expect(s.r1?.text).toBe("partial");
    expect(s.r1?.error).toBe("boom");
  });

  test("pushTransientNotice caps at 5 per run", () => {
    let s: TransientMap = {};
    for (let i = 1; i <= 6; i++) s = pushTransientNotice(s, "r1", "m", `n${i}`);
    expect(s.r1?.notices).toHaveLength(5);
    expect(s.r1?.notices?.[0]).toBe("n2");
    expect(s.r1?.notices?.[4]).toBe("n6");
  });

  test("notices are run-local (no cross-run bleed)", () => {
    let s: TransientMap = {};
    s = pushTransientNotice(s, "r1", "m", "a");
    s = pushTransientNotice(s, "r2", "m", "b");
    expect(s.r1?.notices).toEqual(["a"]);
    expect(s.r2?.notices).toEqual(["b"]);
  });
});

describe("transient reducer — approval", () => {
  test("setTransientApproval creates and replaces per run", () => {
    let s: TransientMap = {};
    s = setTransientApproval(s, "r1", "m", { callId: "c1", toolName: "bash", reason: "r1" });
    expect(s.r1?.approval).toMatchObject({ callId: "c1", toolName: "bash" });
    s = setTransientApproval(s, "r1", "m", { callId: "c2", toolName: "read", reason: "r2" });
    expect(s.r1?.approval?.callId).toBe("c2");
  });

  test("clearTransientApproval removes only that run's approval", () => {
    let s: TransientMap = {};
    s = setTransientApproval(s, "r1", "m", { callId: "c1", toolName: "bash", reason: "r1" });
    s = setTransientApproval(s, "r2", "m", { callId: "c9", toolName: "read", reason: "r2" });
    s = clearTransientApproval(s, "r1");
    expect(s.r1?.approval).toBeUndefined();
    expect(s.r2?.approval?.callId).toBe("c9");
  });
});

describe("transient reducer — tool keys", () => {
  test("toolKey distinguishes runId and callId collisions", () => {
    expect(toolKey("r1", "c1")).toBe("r1:c1");
    expect(toolKey("r1", "c1")).not.toBe(toolKey("r1", "c2"));
    expect(toolKey("r1", "c1")).not.toBe(toolKey("r2", "c1"));
  });
});
