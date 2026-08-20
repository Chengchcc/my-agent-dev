import { rename, rm } from "node:fs/promises";
import type { BackendModelRef } from "@chengchenccc/agent-backend";
import { loopReducer } from "@chengchenccc/loop";
import { Elysia, t } from "elysia";
import { ConflictError } from "../../infra/domain-errors.js";
import type { AgentRunExecutionService } from "../agent-run/execution.js";
import type { AgentRunService } from "../agent-run/service.js";
import type { ConversationPort } from "../conversation/ports.js";
import type { CronScheduler } from "../cron/scheduler.js";
import type { CronJobService } from "../cron/service.js";
import { resolveLoopPaths } from "../loop/resolve-paths.js";
import type { ProjectPort } from "../project/ports.js";
import type { SettingsService } from "../settings/index.js";
import {
  createLoop,
  getLoopDetail,
  getTodayWork,
  listLoops,
  refineLoop,
  reviewLoop,
  runLoop,
} from "./loop-service.js";
import type { LoopStateStore } from "./loop-state-store.js";
import { loopGeneratorConversationId } from "./loop-step.js";

export function loopRoutes(input: {
  cronSvc: CronJobService;
  scheduler: CronScheduler;
  dataDir: string;
  store: LoopStateStore;
  projectPort?: ProjectPort;
  convPort: ConversationPort;
  agentRunService: AgentRunService;
  agentRunExecution: AgentRunExecutionService;
  resolveModel: (modelName: string) => Promise<BackendModelRef>;
  settingsSvc?: SettingsService;
  agentWorkspaceOf: (agentId: string) => Promise<string | null>;
  withWorkspaceLock: <T>(root: string, fn: () => Promise<T>) => Promise<T>;
  withLoopLock?: <T>(loopId: string, fn: () => Promise<T>) => Promise<T>;
}) {
  const {
    cronSvc,
    scheduler,
    dataDir,
    store,
    projectPort,
    convPort,
    agentRunService,
    agentRunExecution,
    resolveModel,
    settingsSvc,
    agentWorkspaceOf,
    withLoopLock,
  } = input;

  const loopStepDeps = {
    dataDir,
    agentWorkspaceOf,
    withWorkspaceLock: input.withWorkspaceLock,
    store,
    projectPort,
    convPort,
    agentRunService,
    agentRunExecution,
    resolveModel,
    withLoopLock,
  };

  return new Elysia()
    .get("/api/loops", () => {
      return { loops: listLoops(cronSvc, store, dataDir) };
    })
    .get("/api/work/today", () => {
      return { reviewQueue: getTodayWork(cronSvc, store) };
    })
    .get("/api/loops/:id", async ({ params: { id }, set }) => {
      const detail = getLoopDetail(cronSvc, store, id, dataDir);
      if (!detail) {
        set.status = 404;
        return { error: "Not a loop" };
      }
      return { loop: detail };
    })
    .post(
      "/api/loops",
      async ({ body, set }) => {
        const result = await createLoop(
          { cronSvc, dataDir, convPort, settingsSvc },
          {
            name: body.name,
            intent: body.intent,
            goal: body.goal,
            action: body.action,
            acceptance: body.acceptance,
            verifyCommands: body.verifyCommands,
            projectId: body.projectId,
            agent: body.agent,
            cronExpr: body.cronExpr,
          },
        );
        set.status = 201;
        return result;
      },
      {
        body: t.Object({
          name: t.String(),
          intent: t.Optional(t.String()),
          goal: t.Optional(t.String()),
          action: t.Optional(t.String()),
          acceptance: t.Optional(t.String()),
          verifyCommands: t.Optional(t.Array(t.String())),
          projectId: t.Optional(t.String()),
          agent: t.Optional(t.String({ minLength: 1 })),
          cronExpr: t.Optional(t.String()),
        }),
      },
    )
    .post("/api/loops/:id/activate", async ({ params: { id }, set }) => {
      const job = cronSvc.getById(id);
      if (!job?.loopConfigPath) {
        set.status = 404;
        return { error: "Not a loop" };
      }
      await cronSvc.setEnabled(id, true);
      const updated = cronSvc.getById(id);
      if (updated) scheduler.register(updated);
      return { loop: { id, enabled: true, cronExpr: job.cronExpr } };
    })
    .post("/api/loops/:id/deactivate", async ({ params: { id }, set }) => {
      const job = cronSvc.getById(id);
      if (!job?.loopConfigPath) {
        set.status = 404;
        return { error: "Not a loop" };
      }
      await cronSvc.setEnabled(id, false);
      scheduler.unregister(id);
      return { loop: { id, enabled: false, cronExpr: job.cronExpr } };
    })
    .post(
      "/api/loops/:id/refine",
      async ({ params: { id }, body, set }) => {
        const result = await refineLoop({ cronSvc, dataDir, settingsSvc }, id, {
          intent: body.intent,
        });
        if (!result) {
          set.status = 404;
          return { error: "Not a loop" };
        }
        return result;
      },
      {
        body: t.Object({
          intent: t.String(),
        }),
      },
    )
    .post("/api/loops/:id/run", async ({ params: { id }, set }) => {
      const state = await runLoop({ cronSvc, ...loopStepDeps }, id);
      if (!state) {
        set.status = 404;
        return { error: "Not a loop" };
      }
      return { state };
    })
    .post(
      "/api/loops/:id/review",
      async ({ params: { id }, body, set }) => {
        const result = await reviewLoop({ cronSvc, ...loopStepDeps }, id, {
          itemId: body.itemId,
          verdict: body.verdict,
          feedback: body.feedback,
        });
        if (!result) {
          set.status = 404;
          return { error: "Not a loop" };
        }
        return result;
      },
      {
        body: t.Object({
          itemId: t.String(),
          verdict: t.Union([
            t.Literal("approve"),
            t.Literal("reject"),
            t.Literal("promote"),
            t.Literal("retry"),
            t.Literal("dismiss"),
          ]),
          feedback: t.Optional(t.String()),
        }),
      },
    )
    .post(
      "/api/loops/:id/items",
      async ({ params: { id }, body, set }) => {
        const job = cronSvc.getById(id);
        if (!job?.loopConfigPath) {
          set.status = 404;
          return { error: "Not a loop" };
        }
        const state = store.load(id);
        const itemId = body.itemId ?? crypto.randomUUID();
        const newState = loopReducer(state, {
          type: "ADD_ITEM",
          item: {
            id: itemId,
            source: body.source,
            summary: body.summary,
            ...(body.taskClass ? { taskClass: body.taskClass } : {}),
          },
          priority: body.priority,
        });
        store.save(id, newState, {});
        const item = newState.items[itemId];
        set.status = 201;
        return { item };
      },
      {
        body: t.Object({
          itemId: t.Optional(t.String()),
          source: t.String({ minLength: 1 }),
          summary: t.String({ minLength: 1 }),
          priority: t.Optional(t.Number()),
          taskClass: t.Optional(
            t.Union([
              t.Literal("bugfix"),
              t.Literal("feature"),
              t.Literal("refactor"),
              t.Literal("research"),
              t.Literal("review"),
              t.Literal("chore"),
            ]),
          ),
        }),
      },
    )
    .post(
      "/api/loops/:id/items/:itemId/defer",
      async ({ params: { id, itemId }, body, set }) => {
        const job = cronSvc.getById(id);
        if (!job?.loopConfigPath) {
          set.status = 404;
          return { error: "Not a loop" };
        }
        const state = store.load(id);
        const deferAction: {
          type: "DEFER";
          itemId: string;
          reason: string;
          until?: number;
          after?: string[];
        } = {
          type: "DEFER",
          itemId,
          reason: body.reason,
        };
        if (body.until !== undefined) deferAction.until = body.until;
        if (body.after !== undefined) deferAction.after = body.after;
        const newState = loopReducer(state, deferAction);
        store.save(id, newState, {});
        return { item: newState.items[itemId] ?? null };
      },
      {
        body: t.Object({
          reason: t.String({ minLength: 1 }),
          until: t.Optional(t.Number()),
          after: t.Optional(t.Array(t.String())),
        }),
      },
    )
    .post("/api/loops/:id/items/:itemId/undefer", async ({ params: { id, itemId }, set }) => {
      const job = cronSvc.getById(id);
      if (!job?.loopConfigPath) {
        set.status = 404;
        return { error: "Not a loop" };
      }
      const state = store.load(id);
      const newState = loopReducer(state, { type: "UNDEFER", itemId });
      store.save(id, newState, {});
      return { item: newState.items[itemId] ?? null };
    })
    .delete("/api/loops/:id", async ({ params: { id }, set }) => {
      const job = cronSvc.getById(id);
      if (!job) {
        set.status = 404;
        return { error: "Not found" };
      }
      // Reject while a generator/evaluator Run is live: deleting the
      // cron row + LOOP dir under a running child would orphan the Run
      // and its terminal commit.
      const active = await agentRunService.hasActiveRunForConversations([
        loopGeneratorConversationId(id),
      ]);
      if (active) {
        throw new ConflictError("Loop has an active run; stop it before deleting.");
      }
      scheduler.unregister(id);
      const paths = resolveLoopPaths(job, dataDir);
      // Tombstone rename first: if the DB transaction below fails, the
      // directory is restored instead of being half-deleted.
      const tombstone = `${paths.loopConfigPath}.deleting-${Date.now()}`;
      let renamed = false;
      try {
        await rename(paths.loopConfigPath, tombstone);
        renamed = true;
      } catch {
        // Directory may already be missing (partial prior cleanup) — the
        // DB state is the authority.
      }
      try {
        store.delete(id);
        cronSvc.remove(id);
      } catch (err) {
        if (renamed) await rename(tombstone, paths.loopConfigPath).catch(() => {});
        throw err;
      }
      if (renamed) await rm(tombstone, { recursive: true, force: true }).catch(() => {});
      set.status = 204;
      return;
    });
}
