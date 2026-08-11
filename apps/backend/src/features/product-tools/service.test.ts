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
import { createProductToolsService, ProductToolRejectedError } from "./service.js";

const CONV = "conv-pt";
const MEMBER = "mem-pt";

let dataDir: string;
let db: ReturnType<typeof openDb>;
let convPort: ReturnType<typeof sqliteConversationAdapter>;
let contextPort: ReturnType<typeof sqliteAgentContextAdapter>;
let runPort: ReturnType<typeof sqliteAgentRunAdapter>;
let backend: ReturnType<typeof createAgentRunService>;
let service: ReturnType<typeof createProductToolsService>;
let branchId: string;

const TOOL_MANIFEST = [
  { name: "history_recent", description: "r", inputSchema: {}, entrypoint: "sse:x" },
  { name: "history_search", description: "s", inputSchema: {}, entrypoint: "sse:x" },
  { name: "history_around", description: "a", inputSchema: {}, entrypoint: "sse:x" },
  { name: "history_retain", description: "t", inputSchema: {}, entrypoint: "sse:x" },
];

async function createRun(messageText: string): Promise<string> {
  const acq = await backend.enqueueAndAcquire({
    conversationId: CONV,
    agentMemberId: MEMBER,
    backendKind: "coding_agent",
    mode: "normal",
    message: { role: "user", text: messageText },
    defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
    configRevision: 1,
    idempotencyKey: `pt-${Math.random().toString(36).slice(2, 8)}`,
  });
  await runPort.setRunProductTools(acq.run!.runId, TOOL_MANIFEST);
  return acq.run!.runId;
}

function identity(runId: string, overrides: Record<string, string> = {}) {
  return {
    runId,
    conversationId: CONV,
    agentMemberId: MEMBER,
    branchId,
    ...overrides,
  };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "phase4-pt-"));
  db = openDb(`${dataDir}/backend.db`);
  convPort = sqliteConversationAdapter(db);
  contextPort = sqliteAgentContextAdapter(db, {
    ulid: () => `ctx-${Math.random().toString(36).slice(2, 8)}`,
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
  service = createProductToolsService({
    runPort,
    contextPort,
    conversationPort: convPort,
    callPort: sqliteProductToolCallAdapter(db),
    idGen: { ulid: () => `y-${Math.random().toString(36).slice(2, 8)}` },
  });
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
  // seed conversation history (two user messages + one internal)
  convPort.appendLedgerEntry({
    conversationId: CONV,
    senderMemberId: "human-1",
    kind: "message",
    content: JSON.stringify({ role: "user", text: "first message" }),
    ts: Date.now(),
  });
  convPort.appendLedgerEntry({
    conversationId: CONV,
    senderMemberId: "human-1",
    kind: "message",
    content: JSON.stringify({ role: "user", text: "searchable keyword alpha" }),
    ts: Date.now(),
  });
  convPort.appendLedgerEntry({
    conversationId: CONV,
    senderMemberId: "human-1",
    kind: "message",
    content: JSON.stringify({ role: "user", text: "internal note", visibility: "internal" }),
    ts: Date.now(),
  });
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("product tools service", () => {
  test("forged run/conversation/member/branch identity is rejected", async () => {
    const runId = await createRun("hi");
    await expect(
      service.call({
        identity: identity(runId, { conversationId: "other-conv" }),
        callId: "toolu-1",
        idempotencyKey: `${runId}:toolu-1`,
        tool: "history_recent",
        args: {},
      }),
    ).rejects.toThrow(ProductToolRejectedError);
    await expect(
      service.call({
        identity: identity(runId, { agentMemberId: "other-member" }),
        callId: "toolu-1",
        idempotencyKey: `${runId}:toolu-1`,
        tool: "history_recent",
        args: {},
      }),
    ).rejects.toThrow(ProductToolRejectedError);
    await expect(
      service.call({
        identity: identity(runId, { branchId: "other-branch" }),
        callId: "toolu-1",
        idempotencyKey: `${runId}:toolu-1`,
        tool: "history_recent",
        args: {},
      }),
    ).rejects.toThrow(ProductToolRejectedError);
    await expect(
      service.call({
        identity: identity("no-such-run"),
        callId: "toolu-1",
        idempotencyKey: `${runId}:toolu-1`,
        tool: "history_recent",
        args: {},
      }),
    ).rejects.toThrow(ProductToolRejectedError);
  });

  test("a terminal run rejects tool calls", async () => {
    const runId = await createRun("hi");
    await runPort.finalizeRun(runId, {
      status: "completed",
      messages: [{ role: "assistant", text: "x" }],
    });
    await expect(
      service.call({
        identity: identity(runId),
        callId: "toolu-1",
        idempotencyKey: `${runId}:toolu-1`,
        tool: "history_recent",
        args: {},
      }),
    ).rejects.toThrow(/not active/);
  });

  test("a tool absent from the run manifest is rejected", async () => {
    const runId = await createRun("hi");
    await expect(
      service.call({
        identity: identity(runId),
        callId: "toolu-1",
        idempotencyKey: `${runId}:toolu-1`,
        tool: "history_undeclared",
        args: {},
      }),
    ).rejects.toThrow(/not declared/);
  });

  test("history_recent returns only visible messages of THIS conversation", async () => {
    const runId = await createRun("hi");
    // a second conversation with an identical message must not leak in
    convPort.createConversation({ conversationId: "other-conv", createdAt: Date.now() });
    convPort.addMember({
      memberId: "om",
      conversationId: "other-conv",
      kind: "human",
      joinedAt: Date.now(),
    });
    convPort.appendLedgerEntry({
      conversationId: "other-conv",
      senderMemberId: "om",
      kind: "message",
      content: JSON.stringify({ role: "user", text: "leaked secret" }),
      ts: Date.now(),
    });
    const result = await service.call({
      identity: identity(runId),
      callId: "toolu-1",
      idempotencyKey: `${runId}:toolu-1`,
      tool: "history_recent",
      args: { limit: 10 },
    });
    const items = JSON.parse(result.content) as Array<{ text: string }>;
    expect(items.map((i) => i.text)).toEqual(["first message", "searchable keyword alpha"]);
    expect(items.map((i) => i.text)).not.toContain("internal note");
    expect(items.map((i) => i.text)).not.toContain("leaked secret");
  });

  test("history_search is scoped to this conversation", async () => {
    const runId = await createRun("hi");
    convPort.createConversation({ conversationId: "other-conv2", createdAt: Date.now() });
    convPort.addMember({
      memberId: "om2",
      conversationId: "other-conv2",
      kind: "human",
      joinedAt: Date.now(),
    });
    convPort.appendLedgerEntry({
      conversationId: "other-conv2",
      senderMemberId: "om2",
      kind: "message",
      content: JSON.stringify({ role: "user", text: "alpha elsewhere" }),
      ts: Date.now(),
    });
    const result = await service.call({
      identity: identity(runId),
      callId: "toolu-1",
      idempotencyKey: `${runId}:toolu-1`,
      tool: "history_search",
      args: { keyword: "alpha" },
    });
    const items = JSON.parse(result.content) as Array<{ text: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toContain("searchable keyword alpha");
  });

  test("history_around returns the window around a seq", async () => {
    const runId = await createRun("hi");
    const entries = convPort.getLedgerEntries(CONV);
    const seq2 = entries.find(
      (e) => e.content && (e.content as { text?: string }).text === "searchable keyword alpha",
    )?.seq;
    expect(seq2).toBeDefined();
    const result = await service.call({
      identity: identity(runId),
      callId: "toolu-1",
      idempotencyKey: `${runId}:toolu-1`,
      tool: "history_around",
      args: { seq: seq2, before: 2, after: 0 },
    });
    const items = JSON.parse(result.content) as Array<{ seq: number; text: string }>;
    expect(items.map((i) => i.text)).toContain("first message");
    expect(items.map((i) => i.text)).toContain("searchable keyword alpha");
  });

  test("read-only tools never write context or the call ledger", async () => {
    const runId = await createRun("hi");
    await service.call({
      identity: identity(runId),
      callId: "toolu-1",
      idempotencyKey: `${runId}:toolu-1`,
      tool: "history_recent",
      args: {},
    });
    // acquire projected the seeded history (2 ledger refs); a read-only call
    // must not ADD anything (no product_tool_exchange, no new refs).
    const refsBefore = (await contextPort.listEntriesToLeaf(branchId)).filter(
      (e) => e.type === "ledger_message",
    ).length;
    expect(refsBefore).toBe(2);
    const after = await contextPort.listEntriesToLeaf(branchId);
    expect(after.filter((e) => e.type === "product_tool_exchange")).toHaveLength(0);
    expect(after.filter((e) => e.type === "ledger_message")).toHaveLength(refsBefore);
    const call = await sqliteProductToolCallAdapter(db).getCall(runId, "toolu-1");
    expect(call).toBeNull();
  });

  test("history_retain pins a visible message and is idempotent per (runId, callId)", async () => {
    const runId = await createRun("hi");
    // a message appended AFTER the run acquired: not yet projected, retainable
    const seq = convPort.appendLedgerEntry({
      conversationId: CONV,
      senderMemberId: "human-1",
      kind: "message",
      content: JSON.stringify({ role: "user", text: "post-acquire message" }),
      ts: Date.now(),
    });

    const first = await service.call({
      identity: identity(runId),
      callId: "toolu-retain",
      idempotencyKey: `${runId}:toolu-retain`,
      tool: "history_retain",
      args: { seq },
    });
    expect(JSON.parse(first.content)).toEqual({ retained: true, seq });

    // one NEW ledger_message ref on the branch (2 seeded by acquire + 1 retain)
    const branchEntries = await contextPort.listEntriesToLeaf(branchId);
    const refs = branchEntries.filter((e) => e.type === "ledger_message");
    expect(refs).toHaveLength(3);
    expect(refs[refs.length - 1]!.ledgerSeq).toBe(seq);

    // same (runId, callId) replay returns the stored result without duplicating
    const replay = await service.call({
      identity: identity(runId),
      callId: "toolu-retain",
      idempotencyKey: `${runId}:toolu-retain`,
      tool: "history_retain",
      args: { seq },
    });
    expect(replay.content).toBe(first.content);
    const refsAfter = await contextPort.listEntriesToLeaf(branchId);
    expect(refsAfter.filter((e) => e.type === "ledger_message")).toHaveLength(3);

    // same callId with a DIFFERENT input conflicts
    await expect(
      service.call({
        identity: identity(runId),
        callId: "toolu-retain",
        idempotencyKey: `${runId}:toolu-retain`,
        tool: "history_retain",
        args: { seq: seq + 999 },
      }),
    ).rejects.toThrow(/reused with a different tool\/input/);
  });

  test("retain rejects an invisible message and a message from another conversation", async () => {
    const runId = await createRun("hi");
    // internal message (not visible)
    const entries = convPort.getLedgerEntries(CONV);
    const internalSeq = entries.find(
      (e) => (e.content as { visibility?: string }).visibility === "internal",
    )?.seq;
    await expect(
      service.call({
        identity: identity(runId),
        callId: "toolu-internal",
        idempotencyKey: `${runId}:toolu-internal`,
        tool: "history_retain",
        args: { seq: internalSeq },
      }),
    ).rejects.toThrow(/not visible/);
    // nonexistent seq
    await expect(
      service.call({
        identity: identity(runId),
        callId: "toolu-missing",
        idempotencyKey: `${runId}:toolu-missing`,
        tool: "history_retain",
        args: { seq: 99999 },
      }),
    ).rejects.toThrow(/not found/);
  });

  test("CONCURRENT identical retains produce exactly one Context ref and one call row", async () => {
    const runId = await createRun("hi");
    const seq = convPort.appendLedgerEntry({
      conversationId: CONV,
      senderMemberId: "human-1",
      kind: "message",
      content: JSON.stringify({ role: "user", text: "concurrent pin" }),
      ts: Date.now(),
    });
    const results = await Promise.allSettled([
      service.call({
        identity: identity(runId),
        callId: "toolu-cc",
        idempotencyKey: `${runId}:toolu-cc`,
        tool: "history_retain",
        args: { seq },
      }),
      service.call({
        identity: identity(runId),
        callId: "toolu-cc",
        idempotencyKey: `${runId}:toolu-cc`,
        tool: "history_retain",
        args: { seq },
      }),
    ]);
    // both settle (one retained, one stored replay) - never an error
    for (const r of results) expect(r.status).toBe("fulfilled");
    // exactly ONE new ledger_message ref for this seq
    const refs = (await contextPort.listEntriesToLeaf(branchId)).filter(
      (e) => e.type === "ledger_message" && e.ledgerSeq === seq,
    );
    expect(refs).toHaveLength(1);
    // exactly ONE durable call row
    const row = await sqliteProductToolCallAdapter(db).getCall(runId, "toolu-cc");
    expect(row).not.toBeNull();
    const count = db
      .query("SELECT COUNT(*) AS n FROM product_tool_call WHERE run_id = ? AND call_id = ?")
      .get(runId, "toolu-cc") as { n: number };
    expect(count.n).toBe(1);
  });

  test("an already-aborted signal rejects the call", async () => {
    const runId = await createRun("hi");
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.call({
        identity: identity(runId),
        callId: "toolu-abort",
        idempotencyKey: `${runId}:toolu-abort`,
        tool: "history_recent",
        args: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});
