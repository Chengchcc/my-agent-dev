import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { WorkflowDefinitionEventBus } from "./definition-events.js";

/** Workflow DSL MCP server: lets a chat agent read/write a workflow
 *  definition file (`<workflowDir>/<id>.workflow.json`) through ordinary MCP
 *  tools. This is how the workflow-editor chat updates the DSL — the agent
 *  reads the current JSON, applies the instruction, writes it back. The
 *  editor then repolls the definition.
 *
 *  Reuses the SSE transport shape from product-tools (the Oma Worker's
 *  SSEClientTransport speaks it). No per-run bearer here: the server is
 *  bound to 127.0.0.1 and the tools are narrow file operations scoped to
 *  the workflow dir. */

export interface WorkflowMcpServerOptions {
  /** Directory holding `*.workflow.json` files. */
  readonly workflowDir: string;
  readonly host?: string;
  /** 0 = ephemeral port. */
  readonly port?: number;
  /** Emit a "changed" event after workflow_write (SSE live refresh). */
  readonly definitionEvents?: WorkflowDefinitionEventBus;
}

export interface WorkflowMcpServer {
  /** SSE base URL (the entrypoint a child mounts as `sse:<url>`). */
  readonly url: string;
  close(): Promise<void>;
}

function safePath(workflowDir: string, workflowId: string): string {
  // Reject traversal: the id is a bare filename stem.
  if (!/^[A-Za-z0-9._-]+$/.test(workflowId)) {
    throw new Error(`invalid workflow id: ${workflowId}`);
  }
  return join(workflowDir, `${workflowId}.workflow.json`);
}

export async function createWorkflowMcpServer(
  opts: WorkflowMcpServerOptions,
): Promise<WorkflowMcpServer> {
  const { workflowDir, definitionEvents } = opts;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  mkdirSync(workflowDir, { recursive: true });

  const makeServer = (): Server => {
    const s = new Server({ name: "workflow", version: "1.0.0" }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "workflow_read",
          description:
            "Read a workflow definition file by its id (filename stem). Returns the raw .workflow.json content.",
          inputSchema: {
            type: "object",
            properties: { workflowId: { type: "string" } },
            required: ["workflowId"],
          },
        },
        {
          name: "workflow_write",
          description:
            "Overwrite a workflow definition file by its id with the given JSON definition (validated by parseWorkflow on next load).",
          inputSchema: {
            type: "object",
            properties: {
              workflowId: { type: "string" },
              definition: { type: "object" },
            },
            required: ["workflowId", "definition"],
          },
        },
      ],
    }));

    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const workflowId = typeof args.workflowId === "string" ? args.workflowId : "";
      try {
        if (name === "workflow_read") {
          if (!workflowId) throw new Error("workflowId required");
          const file = safePath(workflowDir, workflowId);
          const raw = readFileSync(file, "utf8");
          return { content: [{ type: "text", text: raw }] };
        }
        if (name === "workflow_write") {
          if (!workflowId) throw new Error("workflowId required");
          if (typeof args.definition !== "object" || args.definition === null) {
            throw new Error("definition (object) required");
          }
          // NO file write. The agent's proposed DSL is pushed to the editor
          // over the definition SSE; the editor shows it as an unsaved edit
          // and the user commits it with (Ctrl/Cmd)S. The live file is never
          // touched until the user saves.
          definitionEvents?.emit(workflowId, { trigger: "mcp", definition: args.definition });
          return {
            content: [
              {
                type: "text",
                text: `proposed update for ${workflowId} (${randomUUID().slice(0, 8)}) — review in the editor and save to apply`,
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
