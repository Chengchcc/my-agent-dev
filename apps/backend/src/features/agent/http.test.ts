import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
        workspacePath: input.workspacePath,
        config: input.config,
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
      r.config = input.config;
      if (input.workspacePath !== undefined) r.workspacePath = input.workspacePath;
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
        materializeWorkspace: async (id) => {
          const dir = `/tmp/ws/${id}`;
          mkdirSync(dir, { recursive: true });
          return dir;
        },
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

  test("workspace entries/file list and read, traversal rejected", async () => {
    const app = makeSvc();
    const createResp = await app.handle(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ws", model: { provider: "a", model: "m" } }),
      }),
    );
    const created = (await readJson(createResp)) as { id: string };
    const ws = `/tmp/ws/${created.id}`;
    mkdirSync(`${ws}/knowledge`, { recursive: true });
    writeFileSync(`${ws}/AGENTS.md`, "# rules");
    writeFileSync(`${ws}/knowledge/README.md`, "# kb");

    // List root: dirs first, then files.
    const entriesResp = await app.handle(
      new Request(`http://localhost/api/agents/${created.id}/workspace/entries?path=`),
    );
    expect(entriesResp.status).toBe(200);
    const entries = (await readJson(entriesResp)) as {
      entries: Array<{ name: string; kind: string }>;
    };
    expect(entries.entries.map((e) => e.name).sort()).toEqual([
      "AGENTS.md",
      "agent.yml",
      "knowledge",
    ]);
    expect(entries.entries.find((e) => e.name === "knowledge")?.kind).toBe("dir");

    // Read a file.
    const fileResp = await app.handle(
      new Request(`http://localhost/api/agents/${created.id}/workspace/file?path=AGENTS.md`),
    );
    expect(fileResp.status).toBe(200);
    expect(((await readJson(fileResp)) as { content: string }).content).toBe("# rules");

    // Traversal: ../ escapes the workspace.
    const escapeResp = await app.handle(
      new Request(`http://localhost/api/agents/${created.id}/workspace/file?path=../../etc/passwd`),
    );
    expect(escapeResp.status).toBe(403);
  });
});
