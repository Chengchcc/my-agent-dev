import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { createCronJobService } from "../cron/service.js";
import { loopRoutes } from "./http.js";
import { createLoopStateStore } from "./loop-state-store.js";

/** Minimal real deps for POST /api/loops; everything loopStep-only is stubbed. */
function makeApp() {
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
    deleteCronJob: () => true,
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

  const app = new Elysia().use(
    loopRoutes({
      cronSvc,
      scheduler: {} as never,
      dataDir,
      store,
      convPort: {
        createConversation: () => {},
        addMember: () => {},
      } as never,
      agentRunService: {} as never,
      agentRunExecution: {} as never,
      resolveModel: async () => ({ kind: "anthropic", id: "test" }) as never,
    }),
  );

  return { app, dataDir, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
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
          intent: "每天汇总git issue",
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
});
