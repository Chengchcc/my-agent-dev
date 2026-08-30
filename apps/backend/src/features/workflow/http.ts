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
  resyncTriggers?: () => Promise<void>;
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
        void deps.resyncTriggers?.();
        return { ok: true, definition: body.definition };
      },
      {
        body: t.Object({
          definition: t.Record(t.String(), t.Unknown()),
        }),
      },
    )
    .post(
      "/api/workflow-definitions/:workflowId/chat-patch",
      async ({ params, body }) => {
        const raw = await Bun.file(join(dir, `${params.workflowId}.workflow.json`)).text();
        const definition = JSON.parse(raw);
        return await svc.chatPatch(params.workflowId, definition, body.instruction);
      },
      {
        body: t.Object({ instruction: t.String({ minLength: 1 }) }),
      },
    )
    .post(
      "/api/workflow-definitions/:workflowId/dry-run",
      async ({ params, body }) => {
        const raw = await Bun.file(join(dir, `${params.workflowId}.workflow.json`)).text();
        const definition = JSON.parse(raw);
        return dryRunWorkflow(
          definition,
          body.input ?? {},
          body.mockOutputs ?? {},
          body.startNodeId,
        );
      },
      {
        body: t.Object({
          input: t.Optional(t.Record(t.String(), t.Unknown())),
          mockOutputs: t.Optional(t.Record(t.String(), t.Record(t.String(), t.Unknown()))),
          startNodeId: t.Optional(t.String()),
        }),
      },
    )
    .delete("/api/workflow-definitions/:workflowId", async ({ params }) => {
      const file = join(dir, `${params.workflowId}.workflow.json`);
      rmSync(file, { force: true });
      void deps.resyncTriggers?.();
      return { ok: true };
    })
    .post(
      "/api/workflow-executions",
      async ({ body, set }) => {
        const ref: WorkflowRef = { repo: body.workflowRef.repo, path: body.workflowRef.path };
        const raw = await deps.loadWorkflow(ref);
        const definition = JSON.parse(raw);
        set.status = 201;
        const workflowId = ref.path.replace(/\.workflow\.json$/, "");
        const input: Record<string, unknown> = { ...(body.input ?? {}) };
        if (body.artifacts?.length) input.__artifacts = body.artifacts;
        return await svc.startExecution({
          workflowId,
          definition,
          input,
        });
      },
      {
        body: t.Object({
          workflowRef: t.Object({
            repo: t.String({ minLength: 1 }),
            path: t.String({ minLength: 1 }),
          }),
          input: t.Optional(t.Record(t.String(), t.Unknown())),
          artifacts: t.Optional(t.Array(t.String())),
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
      let pendingHuman = null;
      if (row.status === "waiting_human") {
        const waiting = nodeRuns.find((r) => r.status === "waiting_human");
        if (waiting) pendingHuman = await svc.getPendingHuman(params.executionId, waiting.nodeId);
      }
      return { execution: row, events, nodeRuns, pendingHuman };
    })
    .post("/api/workflow-executions/:executionId/cancel", async ({ params: { executionId } }) => {
      const row = await svc.cancelExecution(executionId);
      if (!row) throw new HttpError("Execution not found", 404);
      return row;
    })
    .delete("/api/workflow-executions/:executionId", async ({ params }) => {
      const ok = await svc.deleteExecution(params.executionId);
      return { ok };
    })
    .get(
      "/api/workflow-executions/:executionId/events",
      async ({ request, params: { executionId } }) => {
        const row = await svc.getExecution(executionId);
        if (!row) throw new HttpError("Execution not found", 404);
        async function* merged(): AsyncGenerator<{
          event: string;
          executionId: string;
          ts: number;
          data: unknown;
          seq?: number;
        }> {
          // Subscribe FIRST (registration is synchronous — events buffer in
          // the queue), then replay persisted history, then stream live.
          // This closes the replay gap; consumers tolerate rare duplicates.
          const bus = await svc.subscribeEvents(executionId);
          const alreadyTerminal = ["success", "failure", "custom"].includes(row!.status);
          const history = await svc.listExecutionEvents(executionId);
          for (const ev of history) {
            yield { event: ev.event, executionId, ts: ev.ts, data: ev.data, seq: ev.seq };
          }
          if (alreadyTerminal) return;
          for await (const ev of bus) {
            yield ev;
          }
        }
        return sseResponse(
          merged(),
          (ev) => ({ id: String(ev.ts), event: "wf", data: ev }),
          request.signal,
        );
      },
    )
    .get("/api/workflow-executions/:executionId", async ({ params }) => {
      const row = await svc.getExecution(params.executionId);
      if (!row) throw new HttpError("Execution not found", 404);
      return row;
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
