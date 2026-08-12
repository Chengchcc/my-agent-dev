import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { AgentRow } from "./domain.js";
import { agentRoutes } from "./http.js";
import type { AgentPort } from "./ports.js";
import { createAgentService } from "./service.js";

function makeSvc() {
  const rows = new Map<string, AgentRow>();
  const port: AgentPort = {
    async create(input) {
      const row: AgentRow = {
        id: input.id,
        name: input.name,
        template: input.template ?? null,
        workspacePath: input.workspacePath,
        modelProvider: input.model.provider,
        modelName: input.model.model,
        backendKind: input.backendKind ?? "coding_agent",
        reasoningEffort: input.reasoningEffort ?? null,
        permissionMode: input.permissionMode ?? "ask",
        maxSteps: input.maxSteps ?? null,
        larkEnabled: input.larkEnabled ?? false,
        larkAppId: input.larkAppId ?? null,
        larkProfileRef: input.larkProfileRef ?? null,
        larkBotDisplayName: input.larkBotDisplayName ?? null,
        createdAt: input.now,
        updatedAt: input.now,
        archivedAt: null,
      };
      rows.set(input.id, row);
      return row;
    },
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async list() {
      return [...rows.values()].filter((r) => r.archivedAt === null);
    },
    async update(id, input) {
      const r = rows.get(id);
      if (!r || r.archivedAt) return null;
      if (input.name !== undefined) r.name = input.name;
      if (input.permissionMode !== undefined) r.permissionMode = input.permissionMode;
      r.updatedAt = input.now;
      return r;
    },
    async archive(id, now) {
      const r = rows.get(id);
      if (!r || r.archivedAt) return null;
      r.archivedAt = now;
      r.updatedAt = now;
      return r;
    },
    async hardDelete(id) {
      const existed = rows.delete(id);
      return { deletedAgent: existed, deletedThreads: 0, deletedMembers: 0 };
    },
  };
  return new Elysia().use(
    agentRoutes(
      createAgentService({
        port,
        idGen: () => crypto.randomUUID().slice(0, 8),
        workspaceRoot: "/tmp",
        materializeWorkspace: async (id) => `/tmp/ws/${id}`,
        purgeWorkspace: async () => {},
        assertNoActiveRun: () => {},
      }),
      { listForAgent: async () => [], setAgentPacks: async () => {} },
    ),
  );
}

async function readJson(resp: Response): Promise<unknown> {
  return resp.json();
}

describe("agent HTTP routes", () => {
  test("POST /api/agents creates agent and returns 201", async () => {
    const app = makeSvc();
    const req = new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test", model: { provider: "anthropic", model: "claude" } }),
    });
    const resp = await app.handle(req);
    expect(resp.status).toBe(201);
    const body = (await readJson(resp)) as { id: string; name: string };
    expect(body.name).toBe("test");
  });

  test("POST /api/agents returns 422 on invalid body", async () => {
    const app = makeSvc();
    const req = new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    const resp = await app.handle(req);
    expect(resp.status).toBe(422); // Elysia TypeBox validation default
  });

  test("GET /api/agents returns list", async () => {
    const app = makeSvc();
    // Create first
    await app.handle(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "a1", model: { provider: "a", model: "m" } }),
      }),
    );
    const resp = await app.handle(new Request("http://localhost/api/agents"));
    expect(resp.status).toBe(200);
    const body = (await readJson(resp)) as unknown[];
    expect(body.length).toBe(1);
  });

  test("GET /api/agents/:id returns 404 for unknown", async () => {
    const app = makeSvc();
    const resp = await app.handle(new Request("http://localhost/api/agents/x"));
    expect(resp.status).toBe(404);
  });

  test("PATCH /api/agents/:id updates agent", async () => {
    const app = makeSvc();
    const createResp = await app.handle(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "old", model: { provider: "a", model: "m" } }),
      }),
    );
    const created = (await readJson(createResp)) as { id: string };
    const resp = await app.handle(
      new Request(`http://localhost/api/agents/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "new" }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await readJson(resp)) as { name: string };
    expect(body.name).toBe("new");
  });

  test("DELETE /api/agents/:id archives agent", async () => {
    const app = makeSvc();
    const createResp = await app.handle(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "a", model: { provider: "a", model: "m" } }),
      }),
    );
    const created = (await readJson(createResp)) as { id: string };
    const resp = await app.handle(
      new Request(`http://localhost/api/agents/${created.id}`, {
        method: "DELETE",
      }),
    );
    expect(resp.status).toBe(200);
  });
});
