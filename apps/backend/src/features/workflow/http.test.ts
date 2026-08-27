import { describe, expect, test } from "bun:test";
import type { WorkflowDefinition } from "@chengchenccc/workflow";
import { workflowRoutes } from "./http.js";
import type { WorkflowExecutionService } from "./service.js";

const def: WorkflowDefinition = {
  version: 1,
  id: "wf",
  nodes: [
    { id: "start", type: "start" },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [{ from: "start", to: "done" }],
};

const fakeService: WorkflowExecutionService = {
  runToCompletion: async () => ({
    executionId: "e1",
    workflowId: "wf",
    definition: def,
    input: {},
    store: {},
    status: "success",
    exit: "success",
    createdAt: 0,
  }),
  startExecution: async (input) => ({
    executionId: "e1",
    workflowId: input.workflowId,
    definition: input.definition,
    input: input.input,
    store: {},
    status: "running",
    createdAt: 1,
  }),
  resolveHumanTask: async (executionId, _nodeId, _answer) => ({
    executionId,
    workflowId: "wf",
    definition: def,
    input: {},
    store: {},
    status: "success",
    exit: "success",
    createdAt: 1,
  }),
  getExecution: async (id) => ({
    executionId: id,
    workflowId: "wf",
    definition: def,
    input: {},
    store: {},
    status: "running",
    createdAt: 1,
  }),
  listNodeRuns: async () => [],
  subscribeEvents: async () => (async function* () {})(),
  recover: async () => {},
  dispose: async () => {},
};

const app = workflowRoutes({
  workflowExecutionService: fakeService,
  loadWorkflow: async () => JSON.stringify(def),
});

describe("workflow http", () => {
  test("POST /api/workflow-executions creates an execution", async () => {
    const resp = await app.handle(
      new Request("http://localhost/api/workflow-executions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowRef: { repo: "org/flows", path: "oncall.workflow.json" },
          input: { issueUrl: "u" },
        }),
      }),
    );
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { executionId: string };
    expect(body.executionId).toBe("e1");
  });

  test("GET /api/workflow-executions/:id returns a row", async () => {
    const resp = await app.handle(new Request("http://localhost/api/workflow-executions/e1"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { executionId: string };
    expect(body.executionId).toBe("e1");
  });

  test("POST human-task resolves", async () => {
    const resp = await app.handle(
      new Request("http://localhost/api/workflow-executions/e1/human-task", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: "h", answer: { approved: true } }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { status: string };
    expect(body.status).toBe("success");
  });
});
