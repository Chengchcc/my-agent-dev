// ponytail: manager logic untested - dynamic SDK imports make mocking complex; two-map bookkeeping is trivial
import type { Tool } from "@chengchenccc/message";
import { adaptMcpTool } from "./mcp-tool-adapter.js";
import type {
  McpConnectionEntry,
  McpConnectionStatus,
  McpServerConfig,
  McpToolCatalogEntry,
} from "./types.js";

export type { McpToolCatalogEntry } from "./types.js";

export interface McpClientManager {
  connect(config: McpServerConfig): Promise<void>;
  disconnect(serverId: string): Promise<void>;
  getTools(agentId: string): Tool[];
  getStatus(serverId: string): McpConnectionStatus | undefined;
  getToolCount(serverId: string): number;
  disconnectAll(): Promise<void>;
  /** Raw tool metadata (name/description/inputSchema) for a connected server. */
  getToolCatalog(serverId: string): McpToolCatalogEntry[];
  /** Wall time of the last successful connect()+listTools(), in ms. */
  getConnectLatencyMs(serverId: string): number | undefined;
  /** sha256 over the sorted tool catalog — changes when the server's surface changes. */
  getSchemaHash(serverId: string): string | undefined;
  /** Invoke a tool on a connected server via the MCP client. */
  callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
  /** disconnect + connect with the stored config. */
  restart(serverId: string): Promise<void>;
}

export function createMcpClientManager(): McpClientManager {
  const connections = new Map<string, McpConnectionEntry>();
  const agentServers = new Map<string, Set<string>>();
  return {
    async connect(config: McpServerConfig): Promise<void> {
      const { serverId, agentId, name, transport } = config;
      if (transport === "stdio" && !config.command) {
        throw new Error(`[mcp] connect failed for ${config.name}: missing required "command"`);
      }
      if (transport === "sse" && !config.url) {
        throw new Error(`[mcp] connect failed for ${config.name}: missing required "url"`);
      }
      connections.set(serverId, {
        config,
        tools: [],
        rawToolSpecs: [],
        client: null,
        transport: null,
        status: "pending",
      });
      try {
        let clientTransport: unknown;
        if (transport === "stdio") {
          const { StdioClientTransport } = await import(
            "@modelcontextprotocol/sdk/client/stdio.js"
          );
          clientTransport = new StdioClientTransport({
            command: config.command!,
            args: config.args ?? [],
            env: config.env,
          });
        } else {
          const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
          clientTransport = new SSEClientTransport(new URL(config.url!));
        }

        const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
        const client = new Client({ name: `mat-${name}`, version: "0.1.0" }, { capabilities: {} });
        await (client as { connect: (t: unknown) => Promise<void> }).connect(clientTransport);

        const startedAt = Date.now();
        const listResult = await (
          client as {
            listTools: () => Promise<{
              tools: {
                name: string;
                description?: string;
                inputSchema?: Record<string, unknown>;
              }[];
            }>;
          }
        ).listTools();

        const tools = listResult.tools.map((tool) =>
          adaptMcpTool(name, tool, client as Parameters<typeof adaptMcpTool>[2]),
        );
        const rawToolSpecs: McpToolCatalogEntry[] = listResult.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        }));

        connections.set(serverId, {
          config,
          tools,
          rawToolSpecs,
          client,
          transport: clientTransport,
          status: "connected",
          connectLatencyMs: Date.now() - startedAt,
        });
      } catch (err) {
        console.error(`[mcp] connect failed for ${config.name}:`, err);
        // ponytail: degraded-mode entry keeps getTools NPE-free without a second lookup
        connections.set(serverId, {
          config,
          tools: [],
          rawToolSpecs: [],
          client: null,
          transport: null,
          status: "failed",
        });
      }
      // Always update the agentId -> serverId reverse map, even on failure.
      let serverIds = agentServers.get(agentId);
      if (!serverIds) {
        serverIds = new Set();
        agentServers.set(agentId, serverIds);
      }
      serverIds.add(serverId);
    },

    async disconnect(serverId: string): Promise<void> {
      try {
        const entry = connections.get(serverId);
        if (entry?.transport) {
          await (entry.transport as { close: () => Promise<void> }).close();
        }
      } catch (err) {
        console.error(`[mcp] disconnect failed for ${serverId}:`, err);
      }
      connections.delete(serverId);
      for (const serverIds of agentServers.values()) {
        serverIds.delete(serverId);
      }
    },

    getTools(agentId: string): Tool[] {
      const serverIds = agentServers.get(agentId);
      if (!serverIds) return [];
      const tools: Tool[] = [];
      for (const serverId of serverIds) {
        const entry = connections.get(serverId);
        if (entry) tools.push(...entry.tools);
      }
      return tools;
    },

    getStatus(serverId: string): McpConnectionStatus | undefined {
      return connections.get(serverId)?.status;
    },

    getToolCount(serverId: string): number {
      return connections.get(serverId)?.tools.length ?? 0;
    },

    getToolCatalog(serverId: string): McpToolCatalogEntry[] {
      const entry = connections.get(serverId);
      if (entry?.status !== "connected") return [];
      return entry.rawToolSpecs;
    },

    getConnectLatencyMs(serverId: string): number | undefined {
      return connections.get(serverId)?.connectLatencyMs;
    },

    getSchemaHash(serverId: string): string | undefined {
      const entry = connections.get(serverId);
      if (entry?.status !== "connected") return undefined;
      const digest = new Bun.CryptoHasher("sha256");
      for (const t of [...entry.rawToolSpecs].sort((a, b) => a.name.localeCompare(b.name))) {
        digest.update(t.name);
        digest.update("\u0000");
        digest.update(JSON.stringify(t.inputSchema ?? {}));
      }
      return digest.digest("hex");
    },

    async callTool(
      serverId: string,
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<unknown> {
      const entry = connections.get(serverId);
      if (entry?.status !== "connected" || !entry.client) {
        throw new Error(`[mcp] server ${serverId} is not connected`);
      }
      const client = entry.client as {
        callTool: (req: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
      };
      return await client.callTool({ name: toolName, arguments: args });
    },

    async restart(serverId: string): Promise<void> {
      const entry = connections.get(serverId);
      if (!entry) throw new Error(`[mcp] server ${serverId} is not registered`);
      const config = entry.config;
      await this.disconnect(serverId);
      await this.connect(config);
    },

    async disconnectAll(): Promise<void> {
      for (const serverId of [...connections.keys()]) {
        const entry = connections.get(serverId);
        try {
          if (entry?.transport) {
            await (entry.transport as { close: () => Promise<void> }).close();
          }
        } catch (err) {
          console.error(`[mcp] disconnect failed for ${serverId}:`, err);
        }
        connections.delete(serverId);
        for (const serverIds of agentServers.values()) {
          serverIds.delete(serverId);
        }
      }
    },
  };
}
