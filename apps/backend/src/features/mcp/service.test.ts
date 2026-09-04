import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpClientManager } from "@chengchenccc/adapter-mcp";
import { fileMcpServerAdapter } from "./adapter-file.js";
import { createMcpRuntimeStatusStore } from "./runtime-status.js";
import { createMcpService, McpServerNotFoundError, McpValidationError } from "./service.js";

const tmp = mkdtempSync(join(tmpdir(), "mcp-catalog-"));
const port = fileMcpServerAdapter(tmp);

let idCount = 0;
const testIdGen = () => `test-mcp-${idCount++}`;

const connectCalls: string[] = [];
const disconnectCalls: string[] = [];

const mockManager: McpClientManager = {
  connect: async (config) => {
    connectCalls.push(config.serverId);
  },
  disconnect: async (serverId) => {
    disconnectCalls.push(serverId);
  },
  getTools: () => [],
  getStatus: () => "connected",
  getToolCount: () => 3,
  disconnectAll: async () => {},
};

/** In-memory agent.yml switch store (the file-first assignment backing). */
const agentSwitches = new Map<string, Array<{ serverId: string; enabled: boolean }>>();

const runtimeStatus = createMcpRuntimeStatusStore();

const svc = createMcpService({
  port,
  mcpClientManager: mockManager,
  runtimeStatus,
  agentExists: async () => true,
  getAgentMcpServers: async (agentId) => agentSwitches.get(agentId) ?? [],
  setAgentMcpServers: async (agentId, entries) => {
    agentSwitches.set(agentId, [...entries]);
  },
  idGen: testIdGen,
});

const svcNoAgent = createMcpService({
  port,
  mcpClientManager: mockManager,
  agentExists: async () => false,
  getAgentMcpServers: async (agentId) => agentSwitches.get(agentId) ?? [],
  setAgentMcpServers: async (agentId, entries) => {
    agentSwitches.set(agentId, [...entries]);
  },
  idGen: testIdGen,
});

describe("McpService (unified catalog, ADR 0022)", () => {
  test("create adds to the GLOBAL catalog; no agent involvement", async () => {
    const row = await svc.create({
      name: "stdio-server",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: { ROOT: "/tmp/data" },
    });
    expect(row.serverId).toStartWith("test-mcp-");
    expect(row.name).toBe("stdio-server");
    expect(row.transport).toBe("stdio");
    expect(row.command).toBe("npx");
    expect(row.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem"]);
    // maskEnv: **** + last4 chars (value "/tmp/data" has 9 chars > 4)
    expect(row.env).toEqual({ ROOT: "****data" });
    expect(row.url).toBeNull();
    expect(svc.listCatalog()).toHaveLength(1);
    // Catalog create does NOT connect (connect happens on assignment).
    expect(connectCalls).toHaveLength(0);
  });

  test("listForAgent returns only the agent's enabled SUBSET", async () => {
    const s1 = await svc.create({ name: "s1", transport: "sse", url: "https://x/sse" });
    await svc.create({ name: "s2", transport: "stdio", command: "echo" });
    await svc.create({ name: "s3", transport: "stdio", command: "ls" });

    // agent-1 opens only s1 out of the three catalog servers.
    await svc.setAgentServers("agent-1", [
      { serverId: s1.serverId, enabled: true },
      { serverId: "test-mcp-1", enabled: false }, // s2 explicitly off
    ]);
    const list = await svc.listForAgent("agent-1");
    expect(list.map((s) => s.name)).toEqual(["s1"]);
    expect(connectCalls).toEqual([s1.serverId]);
  });

  test("setAgentServers rejects unknown catalog ids", async () => {
    await expect(
      svc.setAgentServers("agent-1", [{ serverId: "no-such", enabled: true }]),
    ).rejects.toBeInstanceOf(McpServerNotFoundError);
  });

  test("setAgentServers rejects a missing agent", async () => {
    await expect(svcNoAgent.setAgentServers("ghost", [])).rejects.toBeInstanceOf(
      McpValidationError,
    );
  });

  test("assignments round-trip through the agent.yml store", async () => {
    const s = await svc.create({ name: "assign-me", transport: "stdio", command: "echo" });
    await svc.setAgentServers("agent-2", [{ serverId: s.serverId, enabled: false }]);
    expect(await svc.listAssignments("agent-2")).toEqual([
      { serverId: s.serverId, enabled: false },
    ]);
    await svc.setAgentServers("agent-2", [{ serverId: s.serverId, enabled: true }]);
    expect(await svc.listForAgent("agent-2")).toHaveLength(1);
  });

  test("update + delete operate on the catalog", async () => {
    const row = await svc.create({ name: "before", transport: "stdio", command: "echo" });
    const updated = await svc.update(row.serverId, { name: "after" });
    expect(updated.name).toBe("after");
    await expect(svc.update("no-such", { name: "x" })).rejects.toBeInstanceOf(
      McpServerNotFoundError,
    );
    await svc.delete(row.serverId);
    await expect(svc.delete("no-such")).rejects.toBeInstanceOf(McpServerNotFoundError);
  });

  test("a deleted catalog server drops out of every agent's list", async () => {
    const row = await svc.create({ name: "to-delete", transport: "stdio", command: "echo" });
    await svc.setAgentServers("agent-3", [{ serverId: row.serverId, enabled: true }]);
    await svc.delete(row.serverId);
    // The catalog row is gone; listForAgent resolves only existing ids.
    expect(await svc.listForAgent("agent-3")).toHaveLength(0);
  });
});

describe("McpService runtime status overlay", () => {
  test("listCatalog prefers real runtime mount over manager probe", async () => {
    const row = await svc.create({
      name: "runtime-echo",
      transport: "stdio",
      command: "echo",
    });
    runtimeStatus.record({
      serverName: row.name,
      ok: true,
      toolsCount: 7,
      runId: "run-1",
      at: Date.now(),
    });
    const listed = svc.listCatalog().find((s) => s.serverId === row.serverId);
    expect(listed?.runtimeStatus).toBe("mounted");
    expect(listed?.runtimeToolsCount).toBe(7);
    expect(listed?.runtimeRunId).toBe("run-1");
  });

  test("failed runtime mount surfaces error", async () => {
    const row = await svc.create({
      name: "runtime-bad",
      transport: "stdio",
      command: "echo",
    });
    runtimeStatus.record({
      serverName: row.name,
      ok: false,
      toolsCount: 0,
      error: "connect failed",
      runId: "run-2",
      at: Date.now(),
    });
    const listed = svc.listCatalog().find((s) => s.serverId === row.serverId);
    expect(listed?.runtimeStatus).toBe("failed");
    expect(listed?.runtimeError).toBe("connect failed");
  });
});
