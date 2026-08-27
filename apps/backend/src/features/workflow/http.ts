import { Elysia, t } from "elysia";
import { sseResponse } from "../../http/response.js";
import { HttpError } from "../../infra/errors.js";
import type { WorkflowExecutionService } from "./service.js";

export interface WorkflowRef {
  repo: string;
  path: string;
}

export function workflowRoutes(deps: {
  workflowExecutionService: WorkflowExecutionService;
  loadWorkflow: (ref: WorkflowRef) => Promise<string>;
}) {
  const svc = deps.workflowExecutionService;
  return new Elysia()
    .post(
      "/api/workflow-executions",
      async ({ body, set }) => {
        const ref: WorkflowRef = { repo: body.workflowRef.repo, path: body.workflowRef.path };
        const raw = await deps.loadWorkflow(ref);
        const definition = JSON.parse(raw);
        set.status = 201;
        return await svc.startExecution({
          workflowId: `${ref.repo}/${ref.path}`,
          definition,
          input: body.input ?? {},
        });
      },
      {
        body: t.Object({
          workflowRef: t.Object({
            repo: t.String({ minLength: 1 }),
            path: t.String({ minLength: 1 }),
          }),
          input: t.Optional(t.Record(t.String(), t.Unknown())),
        }),
      },
    )
    .get("/api/workflow-executions/:executionId", async ({ params }) => {
      const row = await svc.getExecution(params.executionId);
      if (!row) throw new HttpError("Execution not found", 404);
      return row;
    })
    .get("/api/workflow-executions/:executionId/events", async ({ request, params }) => {
      const stream = await svc.subscribeEvents(params.executionId, request.signal);
      return sseResponse(
        stream,
        (ev) => ({ id: params.executionId, event: ev.event, data: ev.data }),
        request.signal,
      );
    })
    .post(
      "/api/workflow-executions/:executionId/human-task",
      async ({ params, body }) => {
        return await svc.resolveHumanTask(params.executionId, body.nodeId, body.answer ?? {});
      },
      {
        body: t.Object({
          nodeId: t.String({ minLength: 1 }),
          answer: t.Optional(t.Record(t.String(), t.Unknown())),
        }),
      },
    );
}

export type WorkflowRoutes = ReturnType<typeof workflowRoutes>;
