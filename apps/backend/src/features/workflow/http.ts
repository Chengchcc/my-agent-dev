import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Elysia, t } from "elysia";
import { sseResponse } from "../../http/response.js";
import { HttpError } from "../../infra/errors.js";
import { dryRunWorkflow } from "./dry-run.js";
import type { WorkflowExecutionService } from "./service.js";

export interface WorkflowRef {
  repo: string;
  path: string;
}

export interface WorkflowDefinitionRow {
  workflowId: string;
  name?: string;
  description?: string;
  tags?: string[];
  status?: string;
  owner?: string;
  updatedBy?: string;
  updatedAt: number;
}

export function workflowRoutes(deps: {
  workflowExecutionService: WorkflowExecutionService;
  loadWorkflow: (ref: WorkflowRef) => Promise<string>;
  workflowDir: string;
}) {
  const svc = deps.workflowExecutionService;
  const dir = deps.workflowDir;

  return new Elysia()
    .get("/api/workflow-definitions", async () => {
      mkdirSync(dir, { recursive: true });
      const files = readdirSync(dir).filter((f) => f.endsWith(".workflow.json"));
      const definitions: WorkflowDefinitionRow[] = files.map((f) => {
        const workflowId = f.replace(/\.workflow\.json$/, "");
        let meta: Record<string, unknown>;
        try {
          meta =
            (JSON.parse(readFileSync(join(dir, f), "utf-8")) as { meta?: Record<string, unknown> })
              .meta ?? {};
        } catch {
          meta = {};
        }
        const mtime = statSync(join(dir, f)).mtimeMs;
        return {
          workflowId,
          name: typeof meta.name === "string" ? meta.name : undefined,
          description: typeof meta.description === "string" ? meta.description : undefined,
          tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : undefined,
          status: typeof meta.status === "string" ? meta.status : undefined,
          owner: typeof meta.owner === "string" ? meta.owner : undefined,
          updatedBy: typeof meta.updatedBy === "string" ? meta.updatedBy : undefined,
          updatedAt: Math.round(mtime),
        };
      });
      return { definitions };
    })
    .get("/api/workflow-definitions/:workflowId", async ({ params }) => {
      const file = join(dir, `${params.workflowId}.workflow.json`);
      const raw = await Bun.file(file).text();
      return { definition: JSON.parse(raw) };
    })
    .put(
      "/api/workflow-definitions/:workflowId",
      async ({ params, body }) => {
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${params.workflowId}.workflow.json`);
        writeFileSync(file, JSON.stringify(body.definition, null, 2));
        return { ok: true, definition: body.definition };
      },
      {
        body: t.Object({
          definition: t.Record(t.String(), t.Unknown()),
        }),
      },
    )
    .post(
      "/api/workflow-definitions/:workflowId/dry-run",
      async ({ params, body }) => {
        const raw = await Bun.file(join(dir, `${params.workflowId}.workflow.json`)).text();
        const definition = JSON.parse(raw);
        return dryRunWorkflow(definition, body.input ?? {}, body.mockOutputs ?? {});
      },
      {
        body: t.Object({
          input: t.Optional(t.Record(t.String(), t.Unknown())),
          mockOutputs: t.Optional(t.Record(t.String(), t.Record(t.String(), t.Unknown()))),
        }),
      },
    )
    .delete("/api/workflow-definitions/:workflowId", async ({ params }) => {
      const file = join(dir, `${params.workflowId}.workflow.json`);
      rmSync(file, { force: true });
      return { ok: true };
    })
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
    .get(
      "/api/workflow-executions",
      async ({ query }) => {
        const executions = await svc.listExecutions(query.workflowId ?? undefined);
        return { executions };
      },
      {
        query: t.Object({ workflowId: t.Optional(t.String()) }),
      },
    )
    .get("/api/workflow-executions/:executionId/trace", async ({ params }) => {
      const row = await svc.getExecution(params.executionId);
      if (!row) throw new HttpError("Execution not found", 404);
      const events = await svc.listExecutionEvents(params.executionId);
      const nodeRuns = await svc.listNodeRuns(params.executionId);
      return { execution: row, events, nodeRuns };
    })
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
