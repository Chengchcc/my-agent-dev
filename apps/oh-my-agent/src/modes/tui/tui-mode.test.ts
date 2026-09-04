import { describe, expect, test } from "bun:test";
import { formatModelMeta } from "./tui-mode.js";
import { addUserInput, applyEvent, initialViewState } from "./view-state.js";

describe("view-state folding", () => {
  test("message stream accumulates into one assistant item", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, { type: "message_start" });
    applyEvent(state, { type: "message_update", text: "hello " });
    applyEvent(state, { type: "message_update", text: "world" });
    applyEvent(state, { type: "message_end" });
    applyEvent(state, { type: "agent_end", status: "completed" });
    expect(state.runs).toHaveLength(1);
    const items = state.runs[0]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "hello world" });
    expect(state.runs[0]!.running).toBe(false);
  });

  test("tool start/end keeps one item carrying args and result", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, {
      type: "tool_execution_start",
      toolName: "bash",
      callId: "c1",
      input: { command: "ls -la" },
    });
    applyEvent(state, {
      type: "tool_execution_end",
      toolName: "bash",
      callId: "c1",
      result: { content: "total 0\n[exit: 0]", isError: false },
    });
    applyEvent(state, { type: "agent_end", status: "completed" });
    const items = state.runs[0]!.items;
    const tool = items.find((i) => i.kind === "tool");
    expect(items.filter((i) => i.kind === "tool")).toHaveLength(1);
    expect(tool?.streaming).toBe(false);
    // Args (from start) and result (from end) survive on the settled item so
    // the renderer can draw them under the tool name.
    expect(tool).toMatchObject({
      text: "bash",
      input: { command: "ls -la" },
      result: { content: "total 0\n[exit: 0]", isError: false },
    });
  });

  test("queue_update settles a steered echo after the tools that ran", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    // Steer echo submitted mid-run (pending » item in its own run entry).
    addUserInput(state, "fix the flag", true);
    // A tool renders after the echo was submitted but before the drain.
    applyEvent(state, {
      type: "tool_execution_start",
      toolName: "bash",
      callId: "c1",
      input: { command: "ls" },
    });
    applyEvent(state, {
      type: "tool_execution_end",
      toolName: "bash",
      callId: "c1",
      result: { content: "ok", isError: false },
    });
    // The loop drains the steer: the echo settles at the injection point.
    applyEvent(state, { type: "queue_update", drained: ["fix the flag"] });
    const users = state.runs.flatMap((r) => r.items.filter((i) => i.kind === "user"));
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ text: "fix the flag" });
    expect(users[0]?.pending).toBeFalsy();
    // The settled user item sits AFTER the tool item (pi renders the user
    // message when the loop takes it, not where it was typed).
    const flat = state.runs.flatMap((r) => r.items.map((i) => i.kind));
    expect(flat.indexOf("tool")).toBeLessThan(flat.lastIndexOf("user"));
  });

  test("queue_update without a matching echo changes nothing", () => {
    const state = initialViewState();
    addUserInput(state, "typed", true);
    applyEvent(state, { type: "queue_update", drained: ["never echoed"] });
    const users = state.runs.flatMap((r) => r.items.filter((i) => i.kind === "user"));
    expect(users).toHaveLength(1);
    expect(users[0]?.pending).toBe(true);
  });

  test("thinking merges into assistant; message_end starts a fresh block", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, { type: "thinking_update", text: "turn one reasoning" });
    applyEvent(state, { type: "message_start" });
    applyEvent(state, { type: "message_update", text: "answer" });
    applyEvent(state, { type: "message_end" });
    applyEvent(state, { type: "thinking_update", text: "turn two reasoning" });
    const assistants = state.runs[0]!.items.filter((i) => i.kind === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]).toMatchObject({
      text: "answer",
      thinking: "turn one reasoning",
      streaming: false,
    });
    expect(assistants[1]).toMatchObject({
      text: "",
      thinking: "turn two reasoning",
      streaming: true,
    });
  });

  test("workflow events fold into transcript statuses", () => {
    const state = initialViewState();
    applyEvent(state, { type: "agent_start" });
    applyEvent(state, { type: "workflow_started", workflowId: "w", label: "audit", agentCount: 3 });
    applyEvent(state, {
      type: "workflow_agent_completed",
      workflowId: "w",
      agentId: "a",
      label: "one",
      ok: true,
    });
    applyEvent(state, {
      type: "workflow_agent_completed",
      workflowId: "w",
      agentId: "b",
      label: "two",
      ok: false,
      error: "boom",
    });
    applyEvent(state, {
      type: "workflow_completed",
      workflowId: "w",
      ok: true,
      agentCount: 2,
      totalTokens: 123,
    });
    applyEvent(state, { type: "agent_end", status: "completed" });
    const statuses = state.runs[0]!.items.filter(
      (i) => i.kind === "status" || i.kind === "error",
    ).map((i) => i.text);
    expect(statuses.some((t) => t.includes("audit (3 agents)"))).toBe(true);
    expect(statuses.some((t) => t.includes("one"))).toBe(true);
    expect(statuses.some((t) => t.includes("two: boom"))).toBe(true);
    expect(statuses.some((t) => t.includes("123 tokens"))).toBe(true);
  });

  test("initial view state hides thinking detail and tool detail", () => {
    const state = initialViewState();
    expect(state.showThinking).toBe(false);
    expect(state.showToolDetail).toBe(false);
  });
});

describe("formatModelMeta", () => {
  const base = { displayName: "Fake Echo", contextWindow: 200_000 };

  test("name, context window, free when cost legs are zero", () => {
    expect(formatModelMeta(base)).toBe("Fake Echo · ctx 200k · free");
    expect(formatModelMeta({ ...base, cost: { input: 3, output: 15 } })).toBe(
      "Fake Echo · ctx 200k · $3/15",
    );
  });

  test("current mark and over-context warning", () => {
    expect(formatModelMeta(base, { current: true })).toContain("current");
    expect(formatModelMeta({ ...base, contextWindow: 1_000 }, { contextTokens: 2_000 })).toContain(
      "over current context!",
    );
    // Window larger than the session: no warning.
    expect(formatModelMeta(base, { contextTokens: 2_000 })).not.toContain("over current context");
  });
});
