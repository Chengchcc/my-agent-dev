import { describe, expect, test } from "bun:test";
import { createWorkflowExecutionService } from "./service.js";
import type { WorkflowDefinition } from "@chengchenccc/workflow";

function makeDef(): WorkflowDefinition {
  return {
    version: 1,
    id: "wf",
    nodes: [
      { id: "start", type: "start" },
      {
        id: "s",
        type: "script",
        code: "export default async (ctx) => ({ val: ctx.input.num })",
        output: { val: "number" },
      },
      { id: "done", type: "end", status: "success" },
    ],
    edges: [
      { from: "start", to: "s" },
      { from: "s", to: "done" },
    ],
  };
}

function makeAgentlessDef(): WorkflowDefinition {
  return {
    version: 1,
    id: "wf",
    nodes: [
      { id: "start", type: "start" },
      {
        id: "s",
        type: "script",
        code: "x",
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

function ramPort() {
  const executions = new Map<string, Record<string, unknown>>();
  const nodeRuns: Array<Record<string, unknown>> = [];
  return {
    executions,
    nodeRuns,
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
      listNodeRuns: async () => nodeRuns,
      createPendingHuman: async (r: Record<string, unknown>) => r,
      getPendingHuman: async () => null,
      markPendingHumanResolved: async () => {},
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
            output: { val: ctx.input.num },
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
      nodeRunners: {
        script: { run: async () => ({ output: {} }) },
      } as never,
      eventBus: { emit: () => {}, subscribe: async function* () {} } as never,
      idGen: () => "e1",
    });
    const result = await svc.runToCompletion("e1", {
      workflowId: "wf",
      definition: makeAgentlessDef(),
      input: { num: "not-a-number" },
    });
    expect(result.status).toBe("failure");
    expect(result.exit).toBe("failure");
  });
});
