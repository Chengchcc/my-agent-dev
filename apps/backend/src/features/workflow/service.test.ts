import { describe, expect, test } from "bun:test";
import type { WorkflowDefinition } from "@chengchenccc/workflow";
import { parseWorkflow } from "@chengchenccc/workflow";
import { createWorkflowExecutionService } from "./service.js";

function makeDef(): WorkflowDefinition {
  return {
    version: 1,
    id: "wf",
    nodes: [
      { id: "start", type: "start" },
      {
        id: "s",
        type: "script",
        code: "x",
        output: [{ key: "val", type: "number" }],
        inputSchema: {
          type: "object",
          properties: { num: { type: "integer" } },
          required: ["num"],
        },
      },
      { id: "done", type: "end", status: "success" },
    ],
    edges: [
      { from: "start", to: "s" },
      { from: "s", to: "done" },
    ],
  };
}

function makeHumanDef(): WorkflowDefinition {
  return {
    version: 1,
    id: "wf",
    nodes: [
      { id: "start", type: "start" },
      { id: "h", type: "human", question: "ok?" },
      { id: "done", type: "end", status: "success" },
    ],
    edges: [
      { from: "start", to: "h" },
      { from: "h", to: "done" },
    ],
  };
}

function makeAgentDef(): WorkflowDefinition {
  return {
    version: 1,
    id: "wf",
    nodes: [
      { id: "start", type: "start" },
      { id: "a", type: "agent", agentId: "ag-1", output: [{ key: "val", type: "number" }] },
      { id: "done", type: "end", status: "success" },
    ],
    edges: [
      { from: "start", to: "a" },
      { from: "a", to: "done" },
    ],
  };
}

function ramPort() {
  const executions = new Map<string, Record<string, unknown>>();
  const nodeRuns: Array<Record<string, unknown>> = [];
  const pendingHuman = new Map<string, Record<string, unknown>>();
  return {
    executions,
    nodeRuns,
    pendingHuman,
    port: {
      createExecution: async (i: Record<string, unknown>) => {
        const r = { ...i, status: "running" };
        executions.set(i.executionId as string, r);
        return r;
      },
      getExecution: async (id: string) => executions.get(id) ?? null,
      updateExecution: async (id: string, patch: Record<string, unknown>) => {
        const r = executions.get(id);
        if (r) Object.assign(r, patch);
        return r;
      },
      appendNodeRun: async (i: Record<string, unknown>) => {
        const r = { seq: nodeRuns.length + 1, ...i };
        nodeRuns.push(r);
        return r;
      },
      updateNodeRun: async (_e: string, nodeId: string, patch: Record<string, unknown>) => {
        const r = nodeRuns.find((x) => x.nodeId === nodeId);
        if (r) Object.assign(r, patch);
        return r;
      },
      listNodeRuns: async (executionId: string) =>
        nodeRuns.filter((r) => r.executionId === executionId),
      appendExecutionEvent: async () => {},
      listExecutionEvents: async () => [],
      createPendingHuman: async (r: Record<string, unknown>) => {
        pendingHuman.set(`${r.executionId as string}:${r.nodeId as string}`, r);
        return r;
      },
      getPendingHuman: async (executionId: string, nodeId: string) =>
        pendingHuman.get(`${executionId}:${nodeId}`) ?? null,
      markPendingHumanResolved: async (executionId: string, nodeId: string) => {
        const r = pendingHuman.get(`${executionId}:${nodeId}`);
        if (!r || r.status !== "pending") return false;
        r.status = "resolved";
        return true;
      },
      listRunningExecutions: async () => [],
      listWaitingHumanExecutions: async () => [],
    } as never,
  };
}

describe("createWorkflowExecutionService", () => {
  test("runs a linear workflow to terminal success via runToCompletion", async () => {
    const { port } = ramPort();
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {
        script: {
          run: async (_node: unknown, ctx: { input: Record<string, unknown> }) => ({
            output: { val: ctx.input.val },
          }),
        },
        human: { run: async () => ({ output: {} }) },
      } as never,
      eventBus: { emit: () => {}, subscribe: async function* () {} } as never,
      idGen: () => "e1",
    });
    const result = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeDef(),
      input: { num: 7 },
    });
    expect(result.status).toBe("success");
    expect(result.exit).toBe("success");
  });

  test("input schema violation fails the node and the execution", async () => {
    const { port } = ramPort();
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: { script: { run: async () => ({ output: {} }) } } as never,
      eventBus: { emit: () => {}, subscribe: async function* () {} } as never,
      idGen: () => "e1",
    });
    const result = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeDef(),
      input: { num: "not-a-number" },
    });
    expect(result.status).toBe("failure");
  });

  test("human node pauses at waiting_human, resolveHumanTask resumes to success", async () => {
    const { port } = ramPort();
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      eventBus: { emit: () => {}, subscribe: async function* () {} } as never,
      idGen: () => "e1",
    });
    const paused = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeHumanDef(),
      input: {},
    });
    expect(paused.status).toBe("waiting_human");
    const resumed = await svc.resolveHumanTask("e1", "h", { approved: true });
    expect(resumed.status).toBe("success");
  });

  test("agent node runs a child run and parses JSON output", async () => {
    const { port, nodeRuns } = ramPort();
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      eventBus: { emit: () => {}, subscribe: async function* () {} } as never,
      idGen: () => "e1",
      agentRunService: {
        enqueueAndAcquire: async () => ({ acquired: true, run: { runId: "r1" } }),
        getRun: async () => ({
          status: "completed",
          terminalResult: {
            status: "completed",
            messages: [{ role: "assistant", text: '{"val": 1}' }],
          },
        }),
      } as never,
      agentRunExecution: {
        dispatch: async () => {},
        subscribe: async function* () {
          yield { type: "status", status: "completed" };
        },
      } as never,
      convPort: { getConversation: () => null, createConversation: () => {} } as never,
      conversationService: {
        postMessage: async () => ({ triggeredRuns: [{ runId: "r1", queued: true }] }),
      } as never,
      resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "x" }),
    });
    const result = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeAgentDef(),
      input: {},
    });
    expect(result.status).toBe("success");
    expect(nodeRuns.find((r) => r.nodeId === "a")!.output).toEqual({ val: 1 });
  });

  test("agent node retries with schema error feedback in prompt", async () => {
    const { port, nodeRuns } = ramPort();
    const posted: string[] = [];
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {} as never,
      eventBus: { emit: () => {}, subscribe: async function* () {} } as never,
      idGen: () => "e1",
      agentRunService: {
        getRun: async (runId: string) => ({
          status: "completed",
          terminalResult:
            runId === "r1"
              ? { status: "completed", messages: [{ role: "assistant", text: '{"wrong": 1}' }] }
              : { status: "completed", messages: [{ role: "assistant", text: '{"val": 1}' }] },
        }),
      } as never,
      agentRunExecution: {
        dispatch: async () => {},
        subscribe: async function* () {
          yield { type: "status", status: "completed" };
        },
      } as never,
      convPort: { getConversation: () => null, createConversation: () => {} } as never,
      conversationService: {
        postMessage: async ({ content }: { content: unknown }) => {
          posted.push(String(content));
          return { triggeredRuns: [{ runId: posted.length === 1 ? "r1" : "r2", queued: true }] };
        },
      } as never,
      resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "x" }),
    });
    const def = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        {
          id: "a",
          type: "agent",
          agentId: "ag-1",
          retry: 1,
          outputSchema: {
            type: "object",
            properties: { val: { type: "number" } },
            required: ["val"],
          },
        },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "done" },
      ],
    });
    const result = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: def,
      input: {},
    });
    expect(result.status).toBe("success");
    expect(posted.length).toBe(2);
    expect(posted[1]).toContain("previous attempt failed");
    expect(nodeRuns.find((r) => r.nodeId === "a")!.output).toEqual({ val: 1 });
  });

  test("conditional edge routes by source node output", async () => {
    const { port } = ramPort();
    const svc = createWorkflowExecutionService({
      port,
      nodeRunners: {
        script: {
          run: async (_n: unknown, ctx: { input: Record<string, unknown> }) => ({
            output: { severity: ctx.input.severity },
          }),
        },
      } as never,
      eventBus: { emit: () => {}, subscribe: async function* () {} } as never,
      idGen: () => "e1",
    });
    const def = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "script", code: "x" },
        { id: "done", type: "end", status: "success" },
        { id: "abort", type: "end", status: "failure" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "done", when: { "==": [{ var: "a.output.severity" }, "high"] } },
        { from: "a", to: "abort", when: { "==": [{ var: "a.output.severity" }, "critical"] } },
      ],
    });
    const ok = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: def,
      input: { severity: "high" },
    });
    expect(ok.exit).toBe("success");
    const bad = await svc.runToCompletion("e2", {
      workflowId: "wf",
      definition: def,
      input: { severity: "critical" },
    });
    expect(bad.exit).toBe("failure");
  });
});
