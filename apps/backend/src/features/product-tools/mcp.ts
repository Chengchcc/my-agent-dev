import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { RunTokenContext, RunTokenRegistry } from "./run-token-registry.js";
import type { ProductToolsService } from "./service.js";

/** Wire identity the Oma Worker attaches to every call:
 *  `_meta.identity` with run/conversation/member/branch/callId/idempotencyKey. */
interface WireIdentity {
  runId?: unknown;
  conversationId?: unknown;
  agentId?: unknown;
  branchId?: unknown;
  callId?: unknown;
  idempotencyKey?: unknown;
}
export interface ProductToolsMcpServerOptions {
  readonly service: ProductToolsService;
  /** Per-run bearer registry — the ONLY accepted auth. A token validates
   *  only while its run is live (minted at dispatch, revoked at settle). */
  readonly tokenRegistry: RunTokenRegistry;
  readonly host?: string;
  /** 0 = ephemeral port. */
  readonly port?: number;
}

export interface ProductToolsMcpServer {
  /** Base URL the Oma Worker connects to (entrypoint `sse:<url>`). */
  readonly url: string;
  close(): Promise<void>;
}

function authorize(req: IncomingMessage, registry: RunTokenRegistry): RunTokenContext | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (scheme !== "Bearer" || value === undefined) return null;
  return registry.validate(value);
}

/** MCP layer only: protocol parsing, service-token authentication, input
 *  validation, and error normalization. Business logic lives in
 *  ProductToolsService. Serves the legacy SSE transport the Oma
 *  Worker's SSEClientTransport speaks. */
export async function createProductToolsMcpServer(
  opts: ProductToolsMcpServerOptions,
): Promise<ProductToolsMcpServer> {
  const { service, tokenRegistry } = opts;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  /** B1: one Server per SSE session; the tools/call handler closes over
   *  the authenticated runId and rejects mismatched identity args. */
  const makeServer = (authenticatedRunId: string): Server => {
    const s = new Server(
      { name: "product-tools", version: "1.0.0" },
      {
        capabilities: { tools: {} },
      },
    );

    const identitySchema = {
      type: "object",
      properties: {
        runId: { type: "string" },
        conversationId: { type: "string" },
        agentId: { type: "string" },
        branchId: { type: "string" },
      },
    };
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "history_recent",
          description:
            "Read the most recent messages visible to this agent member in the conversation. Pass the identity from the system prompt.",
          inputSchema: {
            type: "object",
            properties: { limit: { type: "number" }, identity: identitySchema },
          },
        },
        {
          name: "history_search",
          description: "Search the conversation ledger for messages matching a keyword.",
          inputSchema: {
            type: "object",
            properties: {
              keyword: { type: "string" },
              limit: { type: "number" },
              identity: identitySchema,
            },
            required: ["keyword"],
          },
        },
        {
          name: "history_around",
          description: "Read messages around a ledger seq in this conversation.",
          inputSchema: {
            type: "object",
            properties: {
              seq: { type: "number" },
              before: { type: "number" },
              after: { type: "number" },
              identity: identitySchema,
            },
            required: ["seq"],
          },
        },
        {
          name: "history_retain",
          description:
            "Pin a conversation message into this agent's context branch. Semantic mutation; replay-safe.",
          inputSchema: {
            type: "object",
            properties: {
              seq: { type: "number" },
              reason: { type: "string" },
              identity: identitySchema,
            },
            required: ["seq"],
          },
        },
        {
          name: "todo_write",
          description:
            "Replace this run's task list (durable, shown in the product UI). Pass the full desired list as items: [{id: string, text: string, status: pending | in_progress | done}]. The product injects your current list as Current Tasks in the system prompt.",
          inputSchema: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    text: { type: "string" },
                    status: { type: "string", enum: ["pending", "in_progress", "done"] },
                  },
                  required: ["id", "text", "status"],
                },
              },
              identity: identitySchema,
            },
            required: ["items"],
          },
        },
        {
          name: "ask_question",
          description:
            "Ask the user structured questions and wait for answers. Each question needs a string id and question text, a kind of select (with options) or text (free input). Returns {answers:[{id,selectedValues,freeText}]}. Blocks until the user answers in the product UI.",
          inputSchema: {
            type: "object",
            properties: {
              questions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Unique id for this question" },
                    question: { type: "string", description: "The question text" },
                    kind: { type: "string", enum: ["select", "text"] },
                    options: {
                      type: "array",
                      items: { type: "string" },
                      description: "Required when kind=select",
                    },
                  },
                  required: ["id", "question"],
                },
              },
              identity: identitySchema,
            },
            required: ["questions"],
          },
        },
        {
          name: "artifact_upload",
          description:
            "Upload a single artifact file into backend artifact storage. Returns an artifacts://<folder>/<filename> URL.",
          inputSchema: {
            type: "object",
            properties: {
              folder: { type: "string" },
              filename: { type: "string" },
              content: { type: "string" },
              encoding: { type: "string", enum: ["utf8", "base64"] },
              identity: identitySchema,
            },
            required: ["folder", "filename", "content"],
          },
        },
        {
          name: "artifact_download",
          description: "Download an artifact file by its artifacts://<folder>/<filename> URL.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string" },
              identity: identitySchema,
            },
            required: ["url"],
          },
        },
      ],
    }));

    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const meta = (req.params as { _meta?: { identity?: WireIdentity } })._meta;
      // CLI backends cannot attach _meta: the system prompt carries the
      // identity and the model passes it as the `identity` argument.
      const argIdentity = (args.identity ?? {}) as Record<string, unknown>;
      const identity = meta?.identity ?? argIdentity;
      const str = (v: unknown): string => (typeof v === "string" ? v : "");
      const runId = str(identity.runId);
      // B1: the identity args must match the session's authenticated run —
      // a valid bearer for run A cannot act as run B by forging args.
      if (runId && runId !== authenticatedRunId) {
        return {
          content: [
            { type: "text", text: "identity does not match the session's authenticated run" },
          ],
          isError: true,
        };
      }
      // callId/idempotencyKey: injected by the child's wire caller; generated
      // here for CLI backends (the service validates the pairing).
      const callId = str(identity.callId) || randomUUID();
      const idempotencyKey = str(identity.idempotencyKey) || `${runId}:${callId}`;
      try {
        const result = await service.call({
          identity: {
            runId,
            conversationId: str(identity.conversationId),
            agentId: str(identity.agentId),
            branchId: str(identity.branchId),
          },
          callId,
          idempotencyKey,
          tool: name,
          args,
        });
        return {
          content: [{ type: "text", text: result.content }],
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    });

    return s;
  };

  // SSE sessions: GET /sse establishes a stream (keyed by session id), POST
  // /messages delivers JSON-RPC for that session. Both require the token.
  // B1: each session binds the token's authenticated runId — a valid
  // bearer for run A can never act as run B through any session.
  const sessions = new Map<
    string,
    { transport: SSEServerTransport; authenticatedRunId: string; server: Server }
  >();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const caller = authorize(req, tokenRegistry);
    // Audit stamp: caller.runId is the authenticated run this request
    // belongs to (identity args are advisory; the bearer is the truth).
    if (!caller) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "unauthorized", message: "missing or invalid token" }));
      return;
    }
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      // B1: a dedicated Server per session — the handler closure pins the
      // authenticated runId, so identity forgery in tool args is rejected.
      const sessionServer = makeServer(caller.runId);
      sessions.set(transport.sessionId, {
        transport,
        authenticatedRunId: caller.runId,
        server: sessionServer,
      });
      res.on("close", () => sessions.delete(transport.sessionId));
      await sessionServer.connect(transport).catch(() => undefined);
      return;
    }
    if (req.method === "POST" && url.startsWith("/messages")) {
      // SSEClientTransport posts to `/messages?sessionId=<id>`.
      const query = new URL(url, "http://localhost").searchParams.get("sessionId");
      const header = req.headers["mcp-session-id"];
      const sessionId = query ?? (typeof header === "string" ? header : undefined);
      const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!session) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "invalid_request", message: "unknown session" }));
        return;
      }
      if (caller.runId !== session.authenticatedRunId) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ code: "unauthorized", message: "token does not own this session" }),
        );
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
        // force-close keep-alive connections after a grace tick
        setTimeout(() => httpServer.closeAllConnections(), 500);
      });
    },
  };
}
