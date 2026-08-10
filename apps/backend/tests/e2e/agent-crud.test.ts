import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { Elysia } from "elysia";
import { sqliteAgentAdapter } from "../../src/features/agent/adapter-sqlite.js";
import { agentRoutes } from "../../src/features/agent/http.js";
import { createAgentService } from "../../src/features/agent/service.js";
import { openDb } from "../../src/infra/sqlite/db.js";

const dbPath = `/tmp/test-e2e-agents-${Date.now()}.db`;
const db = openDb(dbPath);
const adapter = sqliteAgentAdapter(db);

const svc = createAgentService({
  port: adapter,
  idGen: () => crypto.randomUUID().slice(0, 8),
  workspaceRoot: `/tmp/test-e2e-ws-${Date.now()}`,
  materializeWorkspace: async (id) => {
    const { mkdir } = await import("node:fs/promises");
    const p = `/tmp/test-e2e-ws-${Date.now()}/${id}`;
    await mkdir(p, { recursive: true });
    return p;
  },
  purgeWorkspace: async () => {},
  assertNoActiveRun: () => {},
});

const app = new Elysia().use(
  agentRoutes(svc, { listForAgent: async () => [], setAgentPacks: async () => {} }),
);

afterAll(() => {
  db.close();
  try {
    unlinkSync(dbPath);
  } catch {
    /* best-effort */
  }
});

describe("E2E Agent CRUD", () => {
  test("full agent lifecycle: create → get → list → update → archive → 404", async () => {
    // Create
    const cResp = await app.handle(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "e2e-agent",
          model: { provider: "anthropic", model: "claude" },
        }),
      }),
    );
    expect(cResp.status).toBe(201);
    const created = (await cResp.json()) as { id: string; name: string };
    expect(created.name).toBe("e2e-agent");

    // Get
    const gResp = await app.handle(new Request(`http://localhost/api/agents/${created.id}`));
    expect(gResp.status).toBe(200);

    // List
    const lResp = await app.handle(new Request("http://localhost/api/agents"));
    const list = (await lResp.json()) as unknown[];
    expect(list.length).toBeGreaterThanOrEqual(1);

    // Update
    const uResp = await app.handle(
      new Request(`http://localhost/api/agents/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "renamed" }),
      }),
    );
    const updated = (await uResp.json()) as { name: string };
    expect(updated.name).toBe("renamed");

    // Archive
    const aResp = await app.handle(
      new Request(`http://localhost/api/agents/${created.id}`, {
        method: "DELETE",
      }),
    );
    expect(aResp.status).toBe(200);

    // Get after archive → 404
    const gResp2 = await app.handle(new Request(`http://localhost/api/agents/${created.id}`));
    expect(gResp2.status).toBe(404);
  });
});
