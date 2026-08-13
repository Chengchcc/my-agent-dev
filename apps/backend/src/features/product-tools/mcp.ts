import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ProductToolsService } from "./service.js";

/** Wire identity the Coding Agent Worker attaches to every call:
 *  `_meta.identity` with run/conversation/member/branch/callId/idempotencyKey. */
interface WireIdentity {
  runId?: unknown;
  conversationId?: unknown;
  agentMemberId?: unknown;
  branchId?: unknown;
  callId?: unknown;
  idempotencyKey?: unknown;
}

export interface ProductToolsMcpServerOptions {
  readonly service: ProductToolsService;
  /** Bearer token the Coding Agent Worker sends (PRODUCT_TOOLS_SERVICE_TOKEN). */
  readonly serviceToken: string;
  readonly host?: string;
  /** 0 = ephemeral port. */
  readonly port?: number;
}

export interface ProductToolsMcpServer {
  /** Base URL the Coding Agent Worker connects to (entrypoint `sse:<url>`). */
  readonly url: string;
  close(): Promise<void>;
}

function authorize(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  const [scheme, value] = header.split(" ");
  if (scheme !== "Bearer" || value === undefined) return false;
  // constant-time comparison (equal-length guard + timingSafeEqual)
  const a = new TextEncoder().encode(value);
  const b = new TextEncoder().encode(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** MCP layer only: protocol parsing, service-token authentication, input
 *  validation, and error normalization. Business logic lives in
 *  ProductToolsService. Serves the legacy SSE transport the Coding Agent
 *  Worker's SSEClientTransport speaks. */
export async function createProductToolsMcpServer(
  opts: ProductToolsMcpServerOptions,
): Promise<ProductToolsMcpServer> {
  const { service, serviceToken } = opts;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;

  const server = new Server(
    { name: "product-tools", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const identitySchema = {
    type: "object",
    properties: {
      runId: { type: "string" },
      conversationId: { type: "string" },
      agentMemberId: { type: "string" },
      branchId: { type: "string" },
    },
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
            items: { type: "array" },
            identity: identitySchema,
          },
          required: ["items"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const meta = (req.params as { _meta?: { identity?: WireIdentity } })._meta;
    // CLI backends cannot attach _meta: the system prompt carries the
    // identity and the model passes it as the `identity` argument.
    const argIdentity = (args.identity ?? {}) as Record<string, unknown>;
    const identity = meta?.identity ?? argIdentity;
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    const runId = str(identity.runId);
    // callId/idempotencyKey: injected by the child's wire caller; generated
    // here for CLI backends (the service validates the pairing).
    const callId = str(identity.callId) || randomUUID();
    const idempotencyKey = str(identity.idempotencyKey) || `${runId}:${callId}`;
    try {
      const result = await service.call({
        identity: {
          runId,
          conversationId: str(identity.conversationId),
          agentMemberId: str(identity.agentMemberId),
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

  // SSE sessions: GET /sse establishes a stream (keyed by session id), POST
  // /messages delivers JSON-RPC for that session. Both require the token.
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!authorize(req, serviceToken)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "unauthorized", message: "missing or invalid token" }));
      return;
    }
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      res.on("close", () => transports.delete(transport.sessionId));
      await server.connect(transport).catch(() => undefined);
      return;
    }
    if (req.method === "POST" && url.startsWith("/messages")) {
      // SSEClientTransport posts to `/messages?sessionId=<id>`.
      const query = new URL(url, "http://localhost").searchParams.get("sessionId");
      const header = req.headers["mcp-session-id"];
      const sessionId = query ?? (typeof header === "string" ? header : undefined);
      const transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
      if (!transport) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "invalid_request", message: "unknown session" }));
        return;
      }
      await transport.handlePostMessage(req, res, undefined).catch(() => undefined);
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
