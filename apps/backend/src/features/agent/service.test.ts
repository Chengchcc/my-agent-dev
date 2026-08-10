import { describe, expect, test } from "bun:test";
import type { AgentRow } from "./domain.js";
import type { AgentPort } from "./ports.js";
import { AgentBusyError, AgentNotFoundError, createAgentService } from "./service.js";

function makeInMemoryPort(): AgentPort {
  const rows = new Map<string, AgentRow>();
  return {
    async create(input) {
      const row: AgentRow = {
        id: input.id,
        name: input.name,
        template: input.template ?? null,
        workspacePath: input.workspacePath,
        modelProvider: input.model.provider,
        modelName: input.model.model,
        modelBaseUrl: input.model.baseURL ?? null,
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
    async list(includeArchived) {
      const all = [...rows.values()];
      return includeArchived ? all : all.filter((r) => r.archivedAt === null);
    },
    async update(id, input) {
      const existing = rows.get(id);
      if (!existing || existing.archivedAt) return null;
      if (input.name !== undefined) existing.name = input.name;
      if (input.permissionMode !== undefined) existing.permissionMode = input.permissionMode;
      if (input.maxSteps !== undefined) existing.maxSteps = input.maxSteps;
      existing.updatedAt = input.now;
      return existing;
    },
    async archive(id, now) {
      const existing = rows.get(id);
      if (!existing || existing.archivedAt) return null;
      existing.archivedAt = now;
      existing.updatedAt = now;
      return existing;
    },
    async hardDelete(id) {
      const existed = rows.delete(id);
      return { deletedAgent: existed, deletedThreads: 0, deletedMembers: 0 };
    },
  };
}

function makeSvc(overrides?: {
  assertNoActiveRun?: (id: string) => void;
  purgeWorkspace?: (id: string) => Promise<void>;
}) {
  let next = 1;
  const port = makeInMemoryPort();
  const svc = createAgentService({
    port,
    idGen: () => `agent-${next++}`,
    workspaceRoot: "/tmp/ws",
    materializeWorkspace: async (id) => `/tmp/ws/${id}`,
    purgeWorkspace: overrides?.purgeWorkspace ?? (async () => {}),
    assertNoActiveRun: overrides?.assertNoActiveRun ?? (() => {}),
  });
  return { svc, port };
}

describe("AgentService", () => {
  test("create returns agent with generated id", async () => {
    const { svc } = makeSvc();
    const agent = await svc.create({
      name: "test",
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    expect(agent.id).toStartWith("agent-");
    expect(agent.name).toBe("test");
    expect(agent.permissionMode).toBe("ask");
  });

  test("getById throws AgentNotFoundError for unknown id", async () => {
    const { svc } = makeSvc();
    await expect(svc.getById("nonexistent")).rejects.toThrow(AgentNotFoundError);
  });

  test("getById returns agent after create", async () => {
    const { svc } = makeSvc();
    const created = await svc.create({ name: "a", model: { provider: "anthropic", model: "x" } });
    const found = await svc.getById(created.id);
    expect(found.id).toBe(created.id);
  });

  test("list returns active agents only by default", async () => {
    const { svc } = makeSvc();
    await svc.create({ name: "a1", model: { provider: "anthropic", model: "x" } });
    await svc.create({ name: "a2", model: { provider: "anthropic", model: "x" } });
    const list = await svc.list();
    expect(list.length).toBe(2);
  });

  test("list excludes archived agents", async () => {
    const { svc } = makeSvc();
    const a = await svc.create({ name: "a", model: { provider: "anthropic", model: "x" } });
    await svc.archive(a.id);
    const list = await svc.list();
    expect(list.length).toBe(0);
  });

  test("update changes fields", async () => {
    const { svc } = makeSvc();
    const a = await svc.create({ name: "old", model: { provider: "anthropic", model: "x" } });
    const updated = await svc.update(a.id, { name: "new" });
    expect(updated.name).toBe("new");
  });

  test("update throws on archived agent", async () => {
    const { svc } = makeSvc();
    const a = await svc.create({ name: "a", model: { provider: "anthropic", model: "x" } });
    await svc.archive(a.id);
    await expect(svc.update(a.id, { name: "x" })).rejects.toThrow(AgentNotFoundError);
  });

  test("archive sets archivedAt", async () => {
    const { svc } = makeSvc();
    const a = await svc.create({ name: "a", model: { provider: "anthropic", model: "x" } });
    const archived = await svc.archive(a.id);
    expect(archived.archivedAt).toBeDefined();
  });

  // ─── M11: hardDelete ─────────────────────────────────────────

  test("hardDelete removes agent from port", async () => {
    const purgeLog: string[] = [];
    const port = makeInMemoryPort();
    const svc = createAgentService({
      port,
      idGen: () => "agent-hd",
      workspaceRoot: "/tmp/ws",
      materializeWorkspace: async () => "/tmp/ws/agent-hd",
      purgeWorkspace: async (id) => {
        purgeLog.push(id);
      },
      assertNoActiveRun: () => {},
    });

    await svc.create({ name: "to-delete", model: { provider: "anthropic", model: "x" } });
    await svc.hardDelete("agent-hd");

    // Agent should be gone
    await expect(svc.getById("agent-hd")).rejects.toThrow(AgentNotFoundError);
    // Workspace should be purged
    expect(purgeLog).toContain("agent-hd");
  });

  test("hardDelete throws AgentBusyError when assertNoActiveRun throws", async () => {
    const svc = createAgentService({
      port: makeInMemoryPort(),
      idGen: () => "agent-busy",
      workspaceRoot: "/tmp/ws",
      materializeWorkspace: async () => "/tmp/ws/agent-busy",
      purgeWorkspace: async () => {},
      assertNoActiveRun: () => {
        throw new AgentBusyError("agent-busy");
      },
    });

    await svc.create({ name: "busy", model: { provider: "anthropic", model: "x" } });
    await expect(svc.hardDelete("agent-busy")).rejects.toThrow(AgentBusyError);
  });

  test("hardDelete succeeds when assertNoActiveRun passes", async () => {
    const svc = createAgentService({
      port: makeInMemoryPort(),
      idGen: () => "agent-free",
      workspaceRoot: "/tmp/ws",
      materializeWorkspace: async () => "/tmp/ws/agent-free",
      purgeWorkspace: async () => {},
      assertNoActiveRun: () => {},
    });

    await svc.create({ name: "free", model: { provider: "anthropic", model: "x" } });
    // Should not throw
    await svc.hardDelete("agent-free");
  });
});
