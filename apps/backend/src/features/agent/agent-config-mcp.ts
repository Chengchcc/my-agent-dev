import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentConfigEventBus } from "./agent-config-events.js";

/** Agent-config MCP server: lets a chat agent read/write an agent's config
 *  through ordinary MCP tools. This is how the agent edit page's chat
 *  proposes config changes — `agent_write` emits a "changed" SSE event with
 *  the proposed config; the left form adopts it as an unsaved edit and the
 *  user commits it with Save. The live agent.yml is never touched until the
 *  user saves (mirrors the workflow editor's propose→review→save cadence).
 *
 *  Bound to 127.0.0.1; tools are narrow reads/writes scoped to one agent id. */

export interface AgentConfigMcpServerOptions {
  /** Read the current agent config (from the service cache) by id. */
  readonly readConfig: (agentId: string) => Promise<unknown>;
  readonly host?: string;
  /** 0 = ephemeral port. */
  readonly port?: number;
  /** Emit a "changed" event after agent_write (SSE live refresh). */
  readonly configEvents?: AgentConfigEventBus;
}

export interface AgentConfigMcpServer {
  /** SSE base URL (the entrypoint a child mounts as `sse:<url>`). */
  readonly url: string;
  close(): Promise<void>;
}

export async function createAgentConfigMcpServer(
  opts: AgentConfigMcpServerOptions,
): Promise<AgentConfigMcpServer> {
  const { readConfig, configEvents } = opts;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;

  const makeServer = (): Server => {
    const s = new Server(
      { name: "agent-config", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "agent_read",
          description:
            "Read an agent's current config by its id. Returns the agent config object (agent.yml shape).",
          inputSchema: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
        },
        {
          name: "agent_write",
          description:
            "Propose a new config for an agent by its id. The edit page adopts it as an unsaved edit; the user commits with Save. Never writes agent.yml directly.",
          inputSchema: {
            type: "object",
            properties: {
              agentId: { type: "string" },
              config: { type: "object" },
            },
            required: ["agentId", "config"],
          },
        },
      ],
    }));

    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const agentId = typeof args.agentId === "string" ? args.agentId : "";
      try {
        if (name === "agent_read") {
          if (!agentId) throw new Error("agentId required");
          const config = await readConfig(agentId);
          return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }] };
        }
        if (name === "agent_write") {
          if (!agentId) throw new Error("agentId required");
          if (typeof args.config !== "object" || args.config === null) {
            throw new Error("config (object) required");
          }
          // NO file write. The proposed config is pushed to the edit page over
          // the agent-config SSE; the form shows it as an unsaved edit and the
          // user commits it with Save. The live agent.yml is untouched.
          configEvents?.emit(agentId, { trigger: "mcp", config: args.config });
          return {
            content: [
              {
                type: "text",
                text: `proposed update for ${agentId} (${randomUUID().slice(0, 8)}) — review in the editor and save to apply`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    });
    return s;
  };

  const sessions = new Map<string, { transport: SSEServerTransport; server: Server }>();
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      const sessionServer = makeServer();
      sessions.set(transport.sessionId, { transport, server: sessionServer });
      res.on("close", () => sessions.delete(transport.sessionId));
      await sessionServer.connect(transport).catch(() => undefined);
      return;
    }
    if (req.method === "POST" && url.startsWith("/messages")) {
      const query = new URL(url, "http://localhost").searchParams.get("sessionId");
      const header = req.headers["mcp-session-id"];
      const sessionId = query ?? (typeof header === "string" ? header : undefined);
      const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!session) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "invalid_request", message: "unknown session" }));
        return;
      }
      await session.transport.handlePostMessage(req, res, undefined).catch(() => undefined);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "not_found", message: url }));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `http://${host}:${actualPort}`;

  return {
    url: `${baseUrl}/sse`,
    close() {
      return new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        setTimeout(() => httpServer.closeAllConnections(), 500);
      });
    },
  };
}
