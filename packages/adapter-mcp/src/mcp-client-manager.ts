// ponytail: manager logic untested - dynamic SDK imports make mocking complex; two-map bookkeeping is trivial
import type { Tool } from "@chengchenccc/message";
import { adaptMcpTool } from "./mcp-tool-adapter.js";
import type { McpConnectionEntry, McpConnectionStatus, McpServerConfig } from "./types.js";

export interface McpClientManager {
  connect(config: McpServerConfig): Promise<void>;
  disconnect(serverId: string): Promise<void>;
  getTools(agentId: string): Tool[];
  getStatus(serverId: string): McpConnectionStatus | undefined;
  getToolCount(serverId: string): number;
  disconnectAll(): Promise<void>;
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

        connections.set(serverId, {
          config,
          tools,
          client,
          transport: clientTransport,
          status: "connected",
        });
      } catch (err) {
        console.error(`[mcp] connect failed for ${config.name}:`, err);
        // ponytail: degraded-mode entry keeps getTools NPE-free without a second lookup
        connections.set(serverId, {
          config,
          tools: [],
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
