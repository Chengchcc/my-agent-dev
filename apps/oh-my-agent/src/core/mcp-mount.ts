import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginTool } from "@chengchenccc/agent";

/** Generic .mcp.json mounting (ADR 0022): the workspace bridge writes one
 *  .mcp.json (user servers + product-tools + knowledge); the child mounts
 *  every server EXCEPT "product-tools" (that one rides the run-scoped
 *  manifest path with identity injection). Tool names that collide with
 *  the native tool table are skipped (the native table wins). One client
 *  per server, kept alive for the run. */

interface McpJsonServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface McpCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

type ToolArguments = Record<string, unknown>;

interface McpClientLike {
  callTool(params: { name: string; arguments?: ToolArguments }): Promise<McpCallResult>;
  listTools(): Promise<{
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  }>;
  close(): Promise<void>;
}

function loadMcpConfig(workspaceRoot: string): Record<string, McpJsonServer> {
  const path = join(workspaceRoot, ".mcp.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers?: Record<string, McpJsonServer>;
    };
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

/** Recursively collect every descendant pid of `pid` (pgrep -P walk). */
function collectDescendants(pid: number): number[] {
  const descendants: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const out = Bun.spawnSync(["pgrep", "-P", String(parent)], { stdout: "pipe" })
      .stdout.toString()
      .trim();
    if (!out) continue;
    for (const line of out.split("\n")) {
      const child = Number(line);
      if (child > 0) {
        descendants.push(child);
        queue.push(child);
      }
    }
  }
  return descendants;
}

async function connectServer(name: string, server: McpJsonServer): Promise<McpClientLike | null> {
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    let stdioRootPid: number | null = null;
    let closeSdk: () => Promise<void>;
    let callTool: McpClientLike["callTool"];
    let listTools: McpClientLike["listTools"];
    if (server.url) {
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      const transport = new SSEClientTransport(
        new URL(server.url),
        server.headers ? { requestInit: { headers: server.headers } } : undefined,
      );
      const client = new Client({ name: "oma", version: "0.1.0" }, { capabilities: {} });
      await client.connect(transport);
      callTool = (params) =>
        // MCP wire boundary: the SDK returns a wide content union; our
        // consumer only reads text blocks and isError.
        client.callTool(params) as Promise<McpCallResult>;
      listTools = () => client.listTools();
      closeSdk = () => client.close();
    } else if (server.command) {
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: server.env,
      });
      const client = new Client({ name: "oma", version: "0.1.0" }, { capabilities: {} });
      await client.connect(transport);
      stdioRootPid = transport.pid;
      callTool = (params) =>
        // MCP wire boundary: see the sse branch above.
        client.callTool(params) as Promise<McpCallResult>;
      listTools = () => client.listTools();
      closeSdk = () => client.close();
    } else {
      return null;
    }
    return {
      callTool,
      listTools,
      async close() {
        // Collect the tree BEFORE the SDK close: once the direct child is
        // SIGKILLed, its children are reparented to init and pgrep -P can
        // no longer find them. The npx/shadcn grandchildren inherit the
        // stdio pipes and would otherwise keep the oma process alive.
        const tree =
          stdioRootPid === null ? [] : [stdioRootPid, ...collectDescendants(stdioRootPid)];
        await closeSdk();
        for (const pid of tree) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      },
    };
  } catch (err) {
    console.error(`[mcp-mount] server ${name} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Mount the workspace .mcp.json servers as plugin tools. Never throws;
 *  per-server failures degrade to "server absent". */
export interface MountedMcpServers {
  tools: PluginTool[];
  /** Close every mounted server's transport (kills stdio children). */
  close(): Promise<void>;
}

export async function mountWorkspaceMcpServers(
  workspaceRoot: string,
  nativeNames: ReadonlySet<string>,
): Promise<MountedMcpServers> {
  const servers = loadMcpConfig(workspaceRoot);
  const tools: PluginTool[] = [];
  const clients: McpClientLike[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (name === "product-tools") continue; // manifest path owns it (identity)
    const client = await connectServer(name, server);
    if (!client) continue;
    clients.push(client);
    let listed: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    try {
      listed = (await client.listTools()).tools;
    } catch (err) {
      console.error(
        `[mcp-mount] listTools ${name} failed:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    for (const t of listed) {
      if (nativeNames.has(t.name)) continue; // native table wins on collision
      tools.push({
        name: t.name,
        description: t.description ?? `MCP tool ${t.name} (server ${name})`,
        inputSchema: (t.inputSchema ?? { type: "object" }) as PluginTool["inputSchema"],
        async execute(args) {
          const res = await client.callTool({ name: t.name, arguments: args });
          const text = (res.content ?? [])
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text!)
            .join("\n");
          if (res.isError) throw new Error(text || `mcp tool ${t.name} failed`);
          return { content: text };
        },
      } as PluginTool);
    }
  }
  return {
    tools,
    async close() {
      await Promise.allSettled(clients.map((c) => c.close().catch(() => {})));
    },
  };
}
