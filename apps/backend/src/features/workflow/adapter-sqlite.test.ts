import { describe, expect, test } from "bun:test";
import type { WorkflowDefinition } from "@chengchenccc/workflow";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteWorkflowExecutionAdapter } from "./adapter-sqlite.js";
import type { WorkflowExecutionPort } from "./ports.js";

const db = openDb(":memory:");
const adapter: WorkflowExecutionPort = sqliteWorkflowExecutionAdapter(db);

const def: WorkflowDefinition = {
  version: 1,
  id: "wf",
  nodes: [
    { id: "start", type: "start" },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [{ from: "start", to: "done" }],
};

describe("sqliteWorkflowExecutionAdapter", () => {
  test("create execution, node runs, pending human", async () => {
    await adapter.createExecution({
      executionId: "e1",
      workflowId: "wf",
      definition: def,
      input: {},
      store: {},
    });
    const row = await adapter.getExecution("e1");
    expect(row?.workflowId).toBe("wf");

    const nodeRun = await adapter.appendNodeRun({
      executionId: "e1",
      nodeId: "start",
      status: "completed",
      order: 0,
    });
    expect(nodeRun.nodeId).toBe("start");
    await adapter.updateNodeRun("e1", "start", { output: { ok: true }, routedTo: ["done"] });
    const runs = await adapter.listNodeRuns("e1");
    expect(runs[0]!.output).toEqual({ ok: true });
    expect(runs[0]!.routedTo).toEqual(["done"]);

    await adapter.createPendingHuman({
      executionId: "e1",
      nodeId: "h1",
      question: "ok?",
      form: {},
      status: "pending",
      createdAt: Date.now(),
    });
    const ph = await adapter.getPendingHuman("e1", "h1");
    expect(ph?.status).toBe("pending");
    await adapter.markPendingHumanResolved("e1", "h1");
    expect((await adapter.getPendingHuman("e1", "h1"))?.status).toBe("resolved");
  });

  test("list running and waiting-human executions", async () => {
    await adapter.createExecution({
      executionId: "e2",
      workflowId: "wf",
      definition: def,
      input: {},
      store: {},
    });
    await adapter.updateExecution("e2", { status: "waiting_human" });
    const running = await adapter.listRunningExecutions();
    const waiting = await adapter.listWaitingHumanExecutions();
    expect(running.some((e) => e.executionId === "e1")).toBe(true);
    expect(waiting.some((e) => e.executionId === "e2")).toBe(true);
  });
});
