import { afterEach, describe, expect, test } from "bun:test";
import { createEchoModelStream } from "./__fixtures__/echo-model.js";
import { createWorkflowExecutor } from "./workflow-executor.js";

const events: Array<{ type: string }> = [];
const emit = (e: unknown): void => {
  events.push(e as { type: string });
};

function makeDeps() {
  return {
    makeSubagentStream: (sessionId: string) => createEchoModelStream(`echo:${sessionId}`),
    modelId: "fake/echo",
    summarize: async () => "[summary]",
    contextBudget: { estimate: () => 0, limit: 100_000, triggerRatio: 0.7 },
    tools: [],
    workspaceRoot: "/tmp/wf-test",
    workspaceAccess: "read_only" as const,
    maxConcurrent: 2,
    maxTotal: 4,
    emit,
  };
}

describe("createWorkflowExecutor", () => {
  afterEach(() => {
    events.length = 0;
  });

  test("runWorkflow fans out and aggregates with lifecycle events", async () => {
    const exec = createWorkflowExecutor(makeDeps());
    const result = await exec.runWorkflow({
      workflowId: "wf1",
      label: "audit",
      items: [
        { prompt: "one", label: "a" },
        { prompt: "two", label: "b" },
        { prompt: "three", label: "c" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.items.map((i) => i.text)).toEqual([
      "echo:wf:wf1:a0",
      "echo:wf:wf1:a1",
      "echo:wf:wf1:a2",
    ]);
    expect(events.filter((e) => e.type === "workflow_agent_started")).toHaveLength(3);
    expect(events.filter((e) => e.type === "workflow_agent_completed")).toHaveLength(3);
    const started = events.find((e) => e.type === "workflow_started") as {
      agentCount: number;
    };
    expect(started.agentCount).toBe(3);
    const done = events.find((e) => e.type === "workflow_completed") as { ok: boolean };
    expect(done.ok).toBe(true);
  });

  test("the total cap rejects excess agents with a clear error", async () => {
    const exec = createWorkflowExecutor(makeDeps());
    await expect(
      exec.runWorkflow({
        workflowId: "wf2",
        label: "big",
        items: Array.from({ length: 5 }, (_, i) => ({ prompt: `p${i}` })),
      }),
    ).rejects.toThrow(/4-agent cap/);
  });

  test("a budget gate can refuse new spawns", async () => {
    let budget = 2;
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      budgetGate: () =>
        --budget >= 0 ? { allowed: true } : { allowed: false, reason: "budget exhausted" },
    });
    await expect(
      exec.runWorkflow({
        workflowId: "wf3",
        label: "gated",
        items: [1, 2, 3].map((i) => ({ prompt: `p${i}` })),
      }),
    ).rejects.toThrow(/budget exhausted/);
  });

  test("schema output is parsed from the final JSON text", async () => {
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      makeSubagentStream: () => createEchoModelStream('{"ok":true}'),
    });
    const result = await exec.runSubagent({
      workflowId: "wf4",
      agentId: "a1",
      prompt: "return json",
      label: "x",
      schema: { type: "object" },
    });
    expect(result.output).toEqual({ ok: true });
    expect(result.ok).toBe(true);
  });

  test("malformed schema output marks the agent failed with the error", async () => {
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      makeSubagentStream: () => createEchoModelStream("not json at all"),
    });
    const result = await exec.runSubagent({
      workflowId: "wf5",
      agentId: "a1",
      prompt: "return json",
      schema: { type: "object" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not valid JSON");
  });
  test("a rejected spawn releases its concurrency slot (no deadlock)", async () => {
    let allow = false;
    const exec = createWorkflowExecutor({
      ...makeDeps(),
      maxConcurrent: 1,
      budgetGate: () =>
        allow ? { allowed: true } : { allowed: false, reason: "budget exhausted" },
    });
    await expect(
      exec.runWorkflow({ workflowId: "wf6", label: "denied", items: [{ prompt: "p1" }] }),
    ).rejects.toThrow(/budget exhausted/);
    // The rejected spawn released its slot; a later allowed run completes
    // instead of deadlocking on the leaked acquire.
    allow = true;
    const result = await exec.runWorkflow({
      workflowId: "wf7",
      label: "ok",
      items: [{ prompt: "p2" }],
    });
    expect(result.ok).toBe(true);
  });
});
