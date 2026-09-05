import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpClientManager } from "@chengchenccc/adapter-mcp";
import { Elysia } from "elysia";
import { sqliteAgentAdapter } from "../../src/features/agent/adapter-sqlite.js";
import { agentRoutes } from "../../src/features/agent/http.js";
import { createAgentService } from "../../src/features/agent/service.js";
import { reconcileAgentResources } from "../../src/features/agent/workspace-bridge.js";
import { sqliteKnowledgePackAdapter } from "../../src/features/knowledge/adapter-sqlite.js";
import { knowledgeRoutes } from "../../src/features/knowledge/http.js";
import { createKnowledgeService } from "../../src/features/knowledge/service.js";
import { fileMcpServerAdapter } from "../../src/features/mcp/adapter-file.js";
import { mcpRoutes } from "../../src/features/mcp/http.js";
import { createMcpService } from "../../src/features/mcp/service.js";
import { openDb } from "../../src/infra/sqlite/db.js";

/** E2E (ADR 0022): the resource-switch chain. Catalog servers + knowledge
 *  packs are backend-owned; agent switches ride agent.yml (file-first);
 *  the bridge reconciles the workspace. This test drives the REAL stack:
 *  agent service (writes agent.yml) -> mcp/knowledge services -> bridge
 *  (writes .mcp.json + knowledge links + index). */

const mockManager: McpClientManager = {
  connect: async () => {},
  disconnect: async () => {},
  getTools: () => [],
  getStatus: () => "connected",
  getToolCount: () => 2,
  disconnectAll: async () => {},
  getToolCatalog: () => [],
  getConnectLatencyMs: () => undefined,
  getSchemaHash: () => undefined,
  callTool: async () => ({}),
  restart: async () => {},
};

function buildStack(tmp: string) {
  const db = openDb(join(tmp, "backend.db"));

  // Fixture builtin knowledge pack: <builtinRoot>/kb-fixture/...
  const builtinRoot = join(tmp, "builtin");
  mkdirSync(join(builtinRoot, "kb-fixture"), { recursive: true });
  writeFileSync(join(builtinRoot, "kb-fixture", "README.md"), "# Fixture KB\n\nsample content");

  const knowledgeSvc = createKnowledgeService({
    port: sqliteKnowledgePackAdapter(db),
    dataDir: tmp,
    idGen: () => `kb-${crypto.randomUUID().slice(0, 8)}`,
    builtinRoot,
  });

  // agentSvc is referenced by mcpSvc's callbacks -> declare via a mutable
  // slot, assigned right after.
  const agentSlot: { svc: ReturnType<typeof createAgentService> | null } = { svc: null };

  const mcpSvc = createMcpService({
    port: fileMcpServerAdapter(tmp),
    mcpClientManager: mockManager,
    agentExists: async () => true,
    getAgentMcpServers: async (agentId) => {
      const agent = await agentSlot.svc!.getById(agentId);
      return agent.config.runtime_config.mcp_servers.map((s) => ({
        serverId: s.server_id,
        enabled: s.enabled,
      }));
    },
    setAgentMcpServers: async (agentId, entries) => {
      await agentSlot.svc!.update(agentId, {
        mcpServers: entries.map((e) => ({ serverId: e.serverId, enabled: e.enabled })),
      });
    },
    idGen: () => `mcp-${crypto.randomUUID().slice(0, 8)}`,
  });

  const reconcile: { fn: (agentId: string) => Promise<void> } = {
    fn: async (agentId: string) => {
      const agent = await agentSlot.svc!.getById(agentId);
      const assignedKnowledge = agent.config.runtime_config.knowledge_packs
        .map((packId) => knowledgeSvc.getById(packId))
        .filter((p): p is NonNullable<typeof p> => p !== null && p.status === "ready");
      reconcileAgentResources({
        workspacePath: agent.workspacePath,
        kind: agent.config.runtime_config.runtime,
        skillPacks: [],
        mcpServers: (await mcpSvc.listForAgent(agentId)).map((s) => ({
          name: s.name,
          transport: s.transport,
          url: s.url,
          command: s.command,
        })),
        productTools: [],
        knowledgePacks: assignedKnowledge.map((p) => ({
          id: p.id,
          source: p.installedRef ?? "",
          name: p.name,
          description: p.description,
        })),
      });
    },
  };

  const agentSvc = createAgentService({
    port: sqliteAgentAdapter(db),
    idGen: () => `agent-${crypto.randomUUID().slice(0, 8)}`,
    workspaceRoot: join(tmp, "agents"),
    materializeWorkspace: async (id: string) => {
      const dir = join(tmp, "agents", id);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    purgeWorkspace: async () => {},
    assertNoActiveRun: () => {},
    onUpdate: (agentId) => reconcile.fn(agentId),
  });
  agentSlot.svc = agentSvc;

  const app = new Elysia()
    .use(agentRoutes(agentSvc, { listForAgent: async () => [], setAgentPacks: async () => {} }))
    .use(mcpRoutes(mcpSvc))
    .use(knowledgeRoutes(knowledgeSvc));
  return { db, app };
}

let tmp: string;
let db: ReturnType<typeof openDb>;
let app: ReturnType<typeof buildStack>["app"];

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "resource-switches-"));
  const stack = buildStack(tmp);
  db = stack.db;
  app = stack.app;
});

afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("resource switches (ADR 0022)", () => {
  test("MCP: catalog server + agent.yml switch + .mcp.json merge", async () => {
    // 1. Global catalog entry.
    const createServer = await app.handle(
      new Request("http://localhost/api/mcp-servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "filesystem", transport: "stdio", command: "npx" }),
      }),
    );
    expect(createServer.status).toBe(201);
    const { mcpServer } = (await createServer.json()) as { mcpServer: { serverId: string } };

    // 2. Agent created (workspace materialized).
    const createAgent = await app.handle(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "switchy", model: { provider: "fake", model: "echo" } }),
      }),
    );
    expect(createAgent.status).toBe(201);
    const agent = (await createAgent.json()) as { id: string; workspacePath: string };

    // 3. Switch ON via agent.yml.
    const patchOn = await app.handle(
      new Request(`http://localhost/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mcpServers: [{ serverId: mcpServer.serverId, enabled: true }] }),
      }),
    );
    expect(patchOn.status).toBe(200);

    // agent.yml carries the switch (file-first).
    const agentYml = readFileSync(join(agent.workspacePath, "agent.yml"), "utf-8");
    expect(agentYml).toContain("mcp_servers:");
    expect(agentYml).toContain(mcpServer.serverId);
    // .mcp.json merged the enabled server.
    const mcpJson = JSON.parse(readFileSync(join(agent.workspacePath, ".mcp.json"), "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcpJson.mcpServers.filesystem).toBeDefined();

    // 4. Switch OFF: all off -> the bridge removes .mcp.json entirely.
    const patchOff = await app.handle(
      new Request(`http://localhost/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mcpServers: [{ serverId: mcpServer.serverId, enabled: false }] }),
      }),
    );
    expect(patchOff.status).toBe(200);
    expect(existsSync(join(agent.workspacePath, ".mcp.json"))).toBe(false);
  });

  test("Knowledge: builtin install + agent.yml switch + link + index", async () => {
    // 1. Install the fixture builtin pack into the pool.
    const install = await app.handle(
      new Request("http://localhost/api/knowledge-packs/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "kb-fixture", sourceKind: "builtin" }),
      }),
    );
    expect(install.status).toBe(201);
    const { pack } = (await install.json()) as {
      pack: { id: string; status: string; name: string };
    };
    expect(pack.status).toBe("ready");

    // 2. Agent + switch.
    const createAgent = await app.handle(
      new Request("http://localhost/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "knower", model: { provider: "fake", model: "echo" } }),
      }),
    );
    const agent = (await createAgent.json()) as { id: string; workspacePath: string };

    const patch = await app.handle(
      new Request(`http://localhost/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ knowledgePacks: [pack.id] }),
      }),
    );
    expect(patch.status).toBe(200);

    // agent.yml carries the pack id.
    const agentYml = readFileSync(join(agent.workspacePath, "agent.yml"), "utf-8");
    expect(agentYml).toContain("knowledge_packs:");
    expect(agentYml).toContain(pack.id);

    // The bridge linked the pack + wrote the machine index.
    const link = join(agent.workspacePath, "knowledge", pack.id);
    expect(existsSync(link)).toBe(true);
    expect(readlinkSync(link)).toContain(pack.id);
    const index = readFileSync(join(agent.workspacePath, "knowledge", "index.md"), "utf-8");
    expect(index).toContain("kb-fixture");
    expect(index).toContain("README.md");
  });
});
