import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../infra/sqlite/db.js";
import { createAgentContextService, sqliteAgentContextAdapter } from "../agent-context/index.js";
import { sqliteAgentRunAdapter } from "../agent-run/adapter-sqlite.js";
import { createAgentRunService } from "../agent-run/service.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import { sqliteProductToolCallAdapter } from "./adapter-sqlite.js";
import { createProductToolsMcpServer } from "./mcp.js";
import { createProductToolsService } from "./service.js";

const CONV = "conv-mcp";
const MEMBER = "mem-mcp";
const TOKEN = "test-service-token";

let dataDir: string;
let db: ReturnType<typeof openDb>;
let convPort: ReturnType<typeof sqliteConversationAdapter>;
let contextPort: ReturnType<typeof sqliteAgentContextAdapter>;
let runPort: ReturnType<typeof sqliteAgentRunAdapter>;
let backend: ReturnType<typeof createAgentRunService>;
let server: Awaited<ReturnType<typeof createProductToolsMcpServer>>;
let branchId: string;
let runId: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "phase4-mcp-"));
  db = openDb(`${dataDir}/backend.db`);
  convPort = sqliteConversationAdapter(db);
  contextPort = sqliteAgentContextAdapter(db, {
    ulid: () => `c-${Math.random().toString(36).slice(2, 8)}`,
  });
  const ledgerResolver = {
    async resolveMessage(cid: string, seq: number) {
      const hit = convPort.getLedgerEntry(cid, seq);
      return hit ? (hit.content as never) : null;
    },
  };
  runPort = sqliteAgentRunAdapter(db, {
    contextPort,
    ledgerResolver,
    idGen: { ulid: () => `r-${Math.random().toString(36).slice(2, 8)}` },
  });
  const contextSvc = createAgentContextService({
    port: contextPort,
    idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
    ledgerResolver,
  });
  backend = createAgentRunService({
    port: runPort,
    contextService: contextSvc,
    idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
    ledgerResolver,
  });
  const service = createProductToolsService({
    runPort,
    contextPort,
    conversationPort: convPort,
    callPort: sqliteProductToolCallAdapter(db),
    idGen: { ulid: () => `y-${Math.random().toString(36).slice(2, 8)}` },
  });
  server = await createProductToolsMcpServer({ service, serviceToken: TOKEN });

  convPort.createConversation({ conversationId: CONV, createdAt: Date.now() });
  convPort.addMember({
    memberId: MEMBER,
    conversationId: CONV,
    kind: "agent",
    agentId: "a1",
    joinedAt: Date.now(),
  });
  const tree = await contextPort.getOrCreateTree(CONV, MEMBER);
  const branch = await contextPort.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
  branchId = branch.branchId;
  convPort.appendLedgerEntry({
    conversationId: CONV,
    senderMemberId: "human-1",
    kind: "message",
    content: JSON.stringify({ role: "user", text: "hello mcp" }),
    ts: Date.now(),
  });
  const acq = await backend.enqueueAndAcquire({
    conversationId: CONV,
    agentMemberId: MEMBER,
    backendKind: "coding_agent",
    mode: "normal",
    message: { role: "user", text: "go" },
    defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
    configRevision: 1,
    idempotencyKey: "mcp-run",
  });
  runId = acq.run!.runId;
  await runPort.setRunProductTools(runId, [
    { name: "history_recent", description: "r", inputSchema: {}, entrypoint: "sse:x" },
    { name: "history_search", description: "s", inputSchema: {}, entrypoint: "sse:x" },
    { name: "history_around", description: "a", inputSchema: {}, entrypoint: "sse:x" },
    { name: "history_retain", description: "t", inputSchema: {}, entrypoint: "sse:x" },
  ]);
});

afterEach(async () => {
  await server.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Connect a real MCP client through the SSE transport with the service
 *  token, exactly like the Coding Agent Worker does. */
async function connectClient(token: string) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
  const transport = new SSEClientTransport(
    new URL(server.url),
    token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  );
  const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport as never);
  return client as unknown as {
    listTools(): Promise<{ tools: unknown[] }>;
    callTool(p: {
      name: string;
      arguments?: unknown;
      _meta?: { identity?: Record<string, unknown> };
    }): Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
    close(): Promise<void>;
  };
}

const IDENTITY = {
  runId: "",
  conversationId: CONV,
  agentMemberId: MEMBER,
  branchId: "",
  callId: "toolu-mcp-1",
  idempotencyKey: "",
};

describe("product tools MCP", () => {
  test("listTools exposes the history tools", async () => {
    const client = await connectClient(TOKEN);
    try {
      const tools = await client.listTools();
      const names = (tools.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "history_recent",
          "history_search",
          "history_around",
          "history_retain",
        ]),
      );
    } finally {
      await client.close();
    }
  });

  test("a call with valid identity returns recent history", async () => {
    const client = await connectClient(TOKEN);
    try {
      const res = await client.callTool({
        name: "history_recent",
        arguments: { limit: 10 },
        _meta: {
          identity: { ...IDENTITY, runId, branchId, idempotencyKey: `${runId}:${IDENTITY.callId}` },
        },
      });
      expect(res.isError).not.toBe(true);
      const items = JSON.parse(res.content[0]?.text ?? "[]") as Array<{ text: string }>;
      expect(items.map((i) => i.text)).toContain("hello mcp");
    } finally {
      await client.close();
    }
  });

  test("CLI backends pass the identity as an argument (no _meta)", async () => {
    const client = await connectClient(TOKEN);
    try {
      const res = await client.callTool({
        name: "history_recent",
        arguments: {
          limit: 10,
          identity: { runId, conversationId: CONV, agentMemberId: MEMBER, branchId },
        },
      });
      expect(res.isError).not.toBe(true);
      const items = JSON.parse(res.content[0]?.text ?? "[]") as Array<{ text: string }>;
      expect(items.map((i) => i.text)).toContain("hello mcp");
    } finally {
      await client.close();
    }
  });

  test("a forged identity is normalized to an isError tool result", async () => {
    const client = await connectClient(TOKEN);
    try {
      const res = await client.callTool({
        name: "history_recent",
        arguments: {},
        _meta: { identity: { ...IDENTITY, runId, branchId, conversationId: "forged" } },
      });
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("identity mismatch");
    } finally {
      await client.close();
    }
  });

  test("malformed input is an isError result, not a protocol failure", async () => {
    const client = await connectClient(TOKEN);
    try {
      const res = await client.callTool({
        name: "history_search",
        arguments: {},
        _meta: {
          identity: { ...IDENTITY, runId, branchId, idempotencyKey: `${runId}:${IDENTITY.callId}` },
        },
      });
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("keyword");
    } finally {
      await client.close();
    }
  });

  test("missing or wrong token is rejected with 401", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    const bad = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
    await expect(
      bad.connect(new SSEClientTransport(new URL(server.url)) as never),
    ).rejects.toThrow();
    await bad.close().catch(() => {});
    const wrong = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
    await expect(
      wrong.connect(
        new SSEClientTransport(new URL(server.url), {
          requestInit: { headers: { Authorization: "Bearer wrong-token" } },
        }) as never,
      ),
    ).rejects.toThrow();
    await wrong.close().catch(() => {});
  });

  test("history_retain via MCP is durable and replay-safe", async () => {
    const client = await connectClient(TOKEN);
    try {
      // a post-acquire message to retain
      const seq = convPort.appendLedgerEntry({
        conversationId: CONV,
        senderMemberId: "human-1",
        kind: "message",
        content: JSON.stringify({ role: "user", text: "pin me" }),
        ts: Date.now(),
      });
      const res = await client.callTool({
        name: "history_retain",
        arguments: { seq },
        _meta: {
          identity: { ...IDENTITY, runId, branchId, idempotencyKey: `${runId}:${IDENTITY.callId}` },
        },
      });
      expect(res.isError).not.toBe(true);
      expect(JSON.parse(res.content[0]?.text ?? "{}")).toEqual({ retained: true, seq });
      const refs = (await contextPort.listEntriesToLeaf(branchId)).filter(
        (e) => e.type === "ledger_message",
      );
      expect(refs[refs.length - 1]!.ledgerSeq).toBe(seq);
      // replay with the same callId returns the stored result
      const replay = await client.callTool({
        name: "history_retain",
        arguments: { seq },
        _meta: {
          identity: { ...IDENTITY, runId, branchId, idempotencyKey: `${runId}:${IDENTITY.callId}` },
        },
      });
      expect(replay.content[0]?.text).toBe(res.content[0]?.text);
    } finally {
      await client.close();
    }
  });
});
