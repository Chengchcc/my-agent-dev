import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { DomainError } from "../../infra/domain-errors.js";
import { createCronJobService } from "../cron/service.js";
import { createWorkspaceLockRegistry } from "../project/workspace-lock.js";
import { loopRoutes } from "./http.js";
import { createLoopStateStore } from "./loop-state-store.js";

/** Minimal real deps for the loop routes; everything loopStep-only is
 *  stubbed. `activeRuns` toggles the delete guard. */
function makeApp(activeRuns = false) {
  const rows = new Map<string, Record<string, unknown>>();
  const port = {
    createCronJob(input: Record<string, unknown>) {
      rows.set(String(input.cronJobId), input);
      return input;
    },
    getCronJob(id: string) {
      return rows.get(id) ?? null;
    },
    listCronJobs: () => [...rows.values()],
    listEnabledCronJobs: () => [...rows.values()],
    updateCronJob: () => null,
    deleteCronJob(id: string) {
      return rows.delete(id);
    },
  };
  const cronSvc = createCronJobService({
    port: port as never,
    idGen: () => crypto.randomUUID().slice(0, 8),
    agentExists: async () => true,
  });

  const dataDir = join(tmpdir(), `loop-http-test-${crypto.randomUUID().slice(0, 8)}`);
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE loop_item(
      loop_id TEXT NOT NULL, item_id TEXT NOT NULL,
      source TEXT NOT NULL, summary TEXT NOT NULL,
      step TEXT NOT NULL, attempt INTEGER NOT NULL,
      priority INTEGER NOT NULL, result TEXT,
      generator_run_id TEXT, evaluator_run_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(loop_id, item_id)
    );
    CREATE TABLE loop_budget(
      loop_id TEXT NOT NULL, day TEXT NOT NULL,
      spent INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(loop_id, day)
    );
  `);
  const store = createLoopStateStore(db);

  const app = new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof DomainError) {
        set.status = error.status;
        return { error: error.message };
      }
      throw error;
    })
    .use(
      loopRoutes({
        cronSvc,
        scheduler: { unregister: () => {} } as never,
        dataDir,
        store,
        convPort: {
          createConversation: () => {},
          addMember: () => {},
        } as never,
        agentRunService: {
          hasActiveRunForConversations: async () => activeRuns,
        } as never,
        agentRunExecution: {} as never,
        resolveModel: async () => ({ kind: "anthropic", id: "test" }) as never,
        agentWorkspaceOf: async () => null,
        withWorkspaceLock: createWorkspaceLockRegistry().withLock.bind(
          createWorkspaceLockRegistry(),
        ),
      }),
    );

  return { app, dataDir, db, store, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

async function createLoop(app: ReturnType<typeof makeApp>["app"]): Promise<string> {
  const resp = await app.handle(
    new Request("http://localhost/api/loops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "delete-me",
        goal: "delete me",
        action: "auto fix",
        acceptance: "tests green",
      }),
    }),
  );
  expect(resp.status).toBe(201);
  const body = (await resp.json()) as {
    loop: { id: string; name: string; loopConfigPath: string };
  };
  return body.loop.id;
}

describe("loop HTTP routes", () => {
  test("POST /api/loops creates a manual loop with Chinese intent", async () => {
    const { app, dataDir, cleanup } = makeApp();
    try {
      expect(dataDir).toBeTruthy();
      const req = new Request("http://localhost/api/loops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "每天汇总git issue",
          goal: "每天汇总git issue",
          action: "生成报告,不改代码",
          acceptance: "报告包含新增/进行中/阻塞三节",
          verifyCommands: ["bun run typecheck"],
        }),
      });
      const resp = await app.handle(req);
      expect(resp.status).toBe(201);
      const body = (await resp.json()) as {
        status: string;
        loop: { id: string; name: string; cronExpr: string };
      };
      expect(body.status).toBe("generated");
      expect(body.loop.name).toBe("每天汇总git issue");
      expect(body.loop.cronExpr).toBe("");
    } finally {
      await cleanup();
    }
  });

  test("POST /api/loops without the four elements asks for clarification", async () => {
    const { app, cleanup } = makeApp();
    try {
      const resp = await app.handle(
        new Request("http://localhost/api/loops", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "vague", intent: "do things" }),
        }),
      );
      expect(resp.status).toBe(201);
      const body = (await resp.json()) as { status: string; questions: string[] };
      expect(body.status).toBe("needs_clarification");
      expect(body.questions.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  test("DELETE rejects while a generator/evaluator run is active", async () => {
    const { app, db, cleanup } = makeApp(true);
    try {
      const loopId = await createLoop(app);
      db.query(
        `INSERT INTO loop_item (loop_id, item_id, source, summary, step, attempt, priority, updated_at)
         VALUES (?, 'i1', 'manual', 's', 'fixing', 1, 3, 1)`,
      ).run(loopId);

      const resp = await app.handle(
        new Request(`http://localhost/api/loops/${loopId}`, { method: "DELETE" }),
      );
      expect(resp.status).toBe(409);
      const body = (await resp.json()) as { error: string };
      expect(body.error).toContain("active run");

      // Nothing was deleted.
      const items = db
        .query("SELECT COUNT(*) AS c FROM loop_item WHERE loop_id = ?")
        .get(loopId) as {
        c: number;
      };
      expect(items.c).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("DELETE removes cron row, loop state and the loop directory", async () => {
    const { app, dataDir, db, cleanup } = makeApp(false);
    try {
      const loopId = await createLoop(app);
      const before = db.query("SELECT COUNT(*) AS c FROM loop_item").get() as { c: number };
      expect(before.c).toBe(0);
      db.query(
        `INSERT INTO loop_item (loop_id, item_id, source, summary, step, attempt, priority, updated_at)
         VALUES (?, 'i1', 'manual', 's', 'fixing', 1, 3, 1)`,
      ).run(loopId);
      db.query(`INSERT INTO loop_budget (loop_id, day, spent) VALUES (?, '2026-08-05', 500)`).run(
        loopId,
      );

      const resp = await app.handle(
        new Request(`http://localhost/api/loops/${loopId}`, { method: "DELETE" }),
      );
      expect(resp.status).toBe(204);

      const items = db
        .query("SELECT COUNT(*) AS c FROM loop_item WHERE loop_id = ?")
        .get(loopId) as { c: number };
      const budget = db
        .query("SELECT COUNT(*) AS c FROM loop_budget WHERE loop_id = ?")
        .get(loopId) as { c: number };
      expect(items.c).toBe(0);
      expect(budget.c).toBe(0);
      // The LOOP.md directory was removed.
      expect(existsSync(join(dataDir, "loops", "delete-me"))).toBe(false);
      // Deleting again is a 404 (cron row gone).
      const again = await app.handle(
        new Request(`http://localhost/api/loops/${loopId}`, { method: "DELETE" }),
      );
      expect(again.status).toBe(404);
    } finally {
      await cleanup();
    }
  });
});
