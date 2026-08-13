import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpClientManager } from "@my-agent-team/adapter-mcp";
import { Elysia } from "elysia";
import { fileMcpServerAdapter } from "../../src/features/mcp/adapter-file.js";
import { mcpRoutes } from "../../src/features/mcp/http.js";
import { createMcpService } from "../../src/features/mcp/service.js";

const tmp = mkdtempSync(join(tmpdir(), "e2e-mcp-"));
const port = fileMcpServerAdapter(tmp);
const mockManager: McpClientManager = {
  connect: async () => {},
  disconnect: async () => {},
  getTools: () => [],
  getStatus: () => "connected",
  getToolCount: () => 2,
  disconnectAll: async () => {},
};

const svc = createMcpService({
  port,
  mcpClientManager: mockManager,
  agentExists: async () => true,
  getAgentMcpServers: async () => [],
  setAgentMcpServers: async () => {},
  idGen: () => `mcp-${crypto.randomUUID().slice(0, 8)}`,
});

const app = new Elysia().use(mcpRoutes(svc));

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("E2E MCP Server CRUD (global catalog, ADR 0022)", () => {
  test("create -> list -> update -> delete", async () => {
    // 1. Create stdio server
    const createResp = await app.handle(
      new Request("http://localhost/api/mcp-servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "filesystem",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
          env: { API_KEY: "sk-secret123456" },
        }),
      }),
    );
    expect(createResp.status).toBe(201);
    const { mcpServer } = (await createResp.json()) as {
      mcpServer: { serverId: string; name: string; env: Record<string, string> };
    };
    expect(mcpServer.name).toBe("filesystem");
    // env should be masked
    expect(mcpServer.env.API_KEY).toContain("****");

    // 2. List
    const listResp = await app.handle(new Request("http://localhost/api/mcp-servers"));
    expect(listResp.status).toBe(200);
    const { mcpServers } = (await listResp.json()) as {
      mcpServers: Array<{ serverId: string; status: string; toolsCount: number }>;
    };
    expect(mcpServers.length).toBe(1);
    expect(mcpServers[0]!.status).toBe("connected");
    expect(mcpServers[0]!.toolsCount).toBe(2);

    // 3. Update name
    const updateResp = await app.handle(
      new Request(`http://localhost/api/mcp-servers/${mcpServer.serverId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "renamed-fs" }),
      }),
    );
    expect(updateResp.status).toBe(200);
    const { mcpServer: updated } = (await updateResp.json()) as { mcpServer: { name: string } };
    expect(updated.name).toBe("renamed-fs");

    // 4. Delete
    const delResp = await app.handle(
      new Request(`http://localhost/api/mcp-servers/${mcpServer.serverId}`, {
        method: "DELETE",
      }),
    );
    expect(delResp.status).toBe(204);

    // 5. List after delete -> empty
    const listResp2 = await app.handle(new Request("http://localhost/api/mcp-servers"));
    const { mcpServers: list2 } = (await listResp2.json()) as { mcpServers: unknown[] };
    expect(list2.length).toBe(0);
  });

  test("create SSE server with url", async () => {
    const createResp = await app.handle(
      new Request("http://localhost/api/mcp-servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "remote-server",
          transport: "sse",
          url: "http://localhost:9999/sse",
        }),
      }),
    );
    expect(createResp.status).toBe(201);
    const { mcpServer } = (await createResp.json()) as {
      mcpServer: { transport: string; url: string };
    };
    expect(mcpServer.transport).toBe("sse");
    expect(mcpServer.url).toBe("http://localhost:9999/sse");
  });

  test("delete non-existent -> 404", async () => {
    const delResp = await app.handle(
      new Request("http://localhost/api/mcp-servers/nonexistent", {
        method: "DELETE",
      }),
    );
    expect(delResp.status).toBe(404);
  });
});
