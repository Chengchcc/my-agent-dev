import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginTool } from "../agent-runtime.js";
import { killProcessTree } from "../runtime/process-tree.js";

/** Generic .mcp.json mounting (ADR 0022): the workspace bridge writes one
 *  .mcp.json (user servers + product-tools + knowledge); the child mounts
 *  every server. Tool names that collide with the native tool table are
 *  skipped (the native table wins). One client per server, kept alive for
 *  the run. */

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

/** Expand `${VAR}` placeholders in .mcp.json headers/env from process.env. */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");
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
      const headers = server.headers
        ? Object.fromEntries(Object.entries(server.headers).map(([k, v]) => [k, expandEnvVars(v)]))
        : undefined;
      const transport = new SSEClientTransport(
        new URL(server.url),
        headers ? { requestInit: { headers } } : undefined,
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
      const env = server.env
        ? Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, expandEnvVars(v)]))
        : undefined;
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env,
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
        await closeSdk();
        if (stdioRootPid !== null) killProcessTree(stdioRootPid);
      },
    };
  } catch (err) {
    console.error(`[mcp-mount] server ${name} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** One configured server as a listing row (pi's /mcp list). */
export interface McpServerInfo {
  name: string;
  kind: "stdio" | "url" | "invalid";
  detail: string;
}

/** Configured servers from the workspace .mcp.json, sorted by name.
 *  Never throws — a corrupt file yields []. */
export function listMcpServers(workspaceRoot: string): McpServerInfo[] {
  const servers = loadMcpConfig(workspaceRoot);
  return Object.entries(servers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, server]) => {
      if (server.url) return { name, kind: "url" as const, detail: server.url };
      if (server.command) {
        return {
          name,
          kind: "stdio" as const,
          detail: [server.command, ...(server.args ?? [])].join(" "),
        };
      }
      return { name, kind: "invalid" as const, detail: "no command or url" };
    });
}

const MCP_TEST_TIMEOUT_MS = 10_000;

/** Live-connect one configured server and list its tools (pi's /mcp test).
 *  Reports failure reasons; never throws.
 *  ponytail: a connect that hangs past the timeout leaves the stdio child
 *  running (connectServer exposes no pid) — rare in practice, pkill by
 *  command if it bites. */
export async function testMcpServer(
  workspaceRoot: string,
  name: string,
): Promise<{ ok: boolean; tools: string[]; error?: string }> {
  const servers = loadMcpConfig(workspaceRoot);
  const server = servers[name];
  if (!server) {
    return { ok: false, tools: [], error: `no server named "${name}" in .mcp.json` };
  }
  let timer: Timer | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), MCP_TEST_TIMEOUT_MS);
  });
  let client: McpClientLike | null;
  try {
    client = await Promise.race([connectServer(name, server), timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (!client) {
    return {
      ok: false,
      tools: [],
      error: `connect failed or timed out (${MCP_TEST_TIMEOUT_MS / 1000}s)`,
    };
  }
  try {
    const { tools } = await client.listTools();
    return { ok: true, tools: tools.map((t) => t.name) };
  } catch (err) {
    return {
      ok: false,
      tools: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

/** Per-call timeout for mounted MCP tools (ms). A hung server must never
 * block the Run forever — product tools already bound theirs. Default 120s
 * (MCP tools legitimately run longer than file tools); OMA_MCP_TIMEOUT_MS
 * overrides, 0 disables. */
export function mcpCallTimeoutMs(): number {
  const raw = process.env.OMA_MCP_TIMEOUT_MS;
  let n = raw === undefined ? 120_000 : Number(raw);
  if (!Number.isFinite(n)) n = 120_000;
  const capRaw = process.env.OMA_MAX_TOOL_TIMEOUT_MS;
  const cap = capRaw ? Number(capRaw) : 0;
  if (Number.isFinite(cap) && cap > 0) n = Math.min(n, cap);
  return n;
}

/** Race a tool call against a wall-clock timeout and the run's abort
 * signal. The losing call keeps running server-side (the MCP SDK's
 * callTool takes no signal) but its result lands nowhere. The Bun timer
 * MUST be cleared or the process lingers — hence the finally. */
export async function withCallTimeout<T>(
  call: Promise<T>,
  label: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new Error("Aborted");
  if (timeoutMs <= 0 && !signal) return call;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bail = new Promise<never>((_, reject) => {
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }
    signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
  });
  try {
    return await Promise.race([call, bail]);
  } finally {
    clearTimeout(timer);
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
  pluginServers: readonly import("../plugins/plugin-resolve.js").PluginMcpConfig[] = [],
): Promise<MountedMcpServers> {
  const servers = mergeMcpConfigs(workspaceRoot, pluginServers);
  const tools: PluginTool[] = [];
  const clients: McpClientLike[] = [];
  for (const [name, server] of Object.entries(servers)) {
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
        timeoutMs: mcpCallTimeoutMs(),
        async execute(args, signal) {
          const res = await withCallTimeout(
            client.callTool({ name: t.name, arguments: args }),
            `mcp tool ${t.name}`,
            mcpCallTimeoutMs(),
            signal,
          );
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

/** Expand ${CLAUDE_PLUGIN_ROOT}/${CLAUDE_PROJECT_DIR} in a plugin server
 *  config (spec: Claude plugin .mcp.json compatibility) and export both as
 *  env vars to the spawned server process. */
export function substitutePluginVars(
  server: McpJsonServer,
  ctx: { pluginRoot: string; workspaceRoot: string },
): McpJsonServer {
  const sub = (s: string): string =>
    s
      .replaceAll("${CLAUDE_PLUGIN_ROOT}", ctx.pluginRoot)
      .replaceAll("${CLAUDE_PROJECT_DIR}", ctx.workspaceRoot);
  const out: McpJsonServer = { ...server };
  if (server.command) out.command = sub(server.command);
  if (server.args) out.args = server.args.map(sub);
  if (server.env) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.env)) env[k] = sub(String(v));
    env.CLAUDE_PLUGIN_ROOT = ctx.pluginRoot;
    env.CLAUDE_PROJECT_DIR = ctx.workspaceRoot;
    out.env = env;
  }
  if (server.headers) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.headers)) headers[k] = sub(String(v));
    out.headers = headers;
  }
  return out;
}

/** Workspace .mcp.json wins on name conflicts (spec conflict matrix);
 *  plugin servers keep resolver order otherwise. */
export function mergeMcpConfigs(
  workspaceRoot: string,
  plugins: readonly import("../plugins/plugin-resolve.js").PluginMcpConfig[],
): Record<string, McpJsonServer> {
  const merged: Record<string, McpJsonServer> = loadMcpConfig(workspaceRoot);
  for (const p of plugins) {
    for (const [name, raw] of Object.entries(p.servers)) {
      if (name in merged) continue;
      if (typeof raw !== "object" || raw === null) continue;
      merged[name] = substitutePluginVars(raw as McpJsonServer, {
        pluginRoot: p.pluginRoot,
        workspaceRoot,
      });
    }
  }
  return merged;
}
