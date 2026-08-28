import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  listExecutionEvents: async () => [],
  listExecutions: async () => [
    {
      executionId: "e1",
      workflowId: "wf",
      definition: def,
      input: {},
      store: {},
      status: "success",
      exit: "success",
      createdAt: 1,
    },
  ],
  subscribeEvents: async () => (async function* () {})(),
  recover: async () => {},
  dispose: async () => {},
};

const dir = mkdtempSync(join(tmpdir(), "wf-http-"));

const app = workflowRoutes({
  workflowExecutionService: fakeService,
  loadWorkflow: async () => JSON.stringify(def),
  workflowDir: dir,
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
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

  test("GET /api/workflow-executions returns a list", async () => {
    const resp = await app.handle(new Request("http://localhost/api/workflow-executions"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { executions: Array<{ executionId: string }> };
    expect(body.executions[0]!.executionId).toBe("e1");
  });

  test("workflow definition list/get/put/delete roundtrip", async () => {
    const put = await app.handle(
      new Request("http://localhost/api/workflow-definitions/wf", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition: def }),
      }),
    );
    expect(put.status).toBe(200);
    const get = await app.handle(new Request("http://localhost/api/workflow-definitions/wf"));
    const getBody = (await get.json()) as { definition: { id: string } };
    expect(getBody.definition.id).toBe("wf");
    const list = await app.handle(new Request("http://localhost/api/workflow-definitions"));
    const listBody = (await list.json()) as { definitions: Array<{ workflowId: string }> };
    expect(listBody.definitions[0]!.workflowId).toBe("wf");
    const del = await app.handle(
      new Request("http://localhost/api/workflow-definitions/wf", { method: "DELETE" }),
    );
    expect(del.status).toBe(200);
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

  test("workflow definition dry-run returns exit", async () => {
    await app.handle(
      new Request("http://localhost/api/workflow-definitions/wf", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition: def }),
      }),
    );
    const resp = await app.handle(
      new Request("http://localhost/api/workflow-definitions/wf/dry-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: {}, mockOutputs: {} }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { exit: string; steps: Array<{ nodeId: string }> };
    expect(body.exit).toBe("success");
    expect(body.steps.some((st) => st.nodeId === "start")).toBe(true);
  });

  test("GET trace returns execution events and nodeRuns", async () => {
    const resp = await app.handle(new Request("http://localhost/api/workflow-executions/e1/trace"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      execution: { executionId: string };
      events: unknown[];
      nodeRuns: unknown[];
    };
    expect(body.execution.executionId).toBe("e1");
    expect(Array.isArray(body.events)).toBe(true);
    expect(Array.isArray(body.nodeRuns)).toBe(true);
  });
});
