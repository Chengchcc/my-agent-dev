import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteAgentContextAdapter } from "../agent-context/adapter-sqlite.js";
import type { IdGenerator, LedgerMessageResolver } from "../agent-context/ports.js";
import { createAgentContextService } from "../agent-context/service.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import { sqliteAgentRunAdapter } from "./adapter-sqlite.js";
import { createAgentRunService } from "./service.js";

const db = openDb(":memory:");
const conv = sqliteConversationAdapter(db);
const ctxPort = sqliteAgentContextAdapter(db);
const idGen: IdGenerator = { ulid: () => crypto.randomUUID().replace(/-/g, "").slice(0, 26) };
const ledgerResolver: LedgerMessageResolver = {
  async resolveMessage(conversationId, ledgerSeq) {
    const entry = conv.getLedgerEntry(conversationId, ledgerSeq);
    if (!entry) return null;
    return entry.content as never;
  },
};
const ctxService = createAgentContextService({ port: ctxPort, idGen, ledgerResolver });
const runPort = sqliteAgentRunAdapter(db, { contextPort: ctxPort, ledgerResolver, idGen });
const runService = createAgentRunService({
  port: runPort,
  contextService: ctxService,
  idGen,
  ledgerResolver,
});

function freshFixture(prefix: string) {
  const conversationId = `conv-svc-${prefix}`;
  const agentMemberId = `mem-svc-${prefix}`;
  conv.createConversation({ conversationId, triggerMode: "mention", createdAt: Date.now() });
  conv.addMember({
    memberId: agentMemberId,
    conversationId,
    kind: "agent",
    agentId: `ag-svc-${prefix}`,
    displayName: `SvcAgent-${prefix}`,
    joinedAt: Date.now(),
  });
  conv.appendLedgerEntry({
    conversationId,
    senderMemberId: agentMemberId,
    addressedTo: [],
    kind: "message",
    content: JSON.stringify({ role: "user", text: `hello-${prefix}` }),
    ts: Date.now(),
  });
  return { conversationId, agentMemberId };
}

afterAll(() => db.close());

describe("Agent Run service: frozen Run config", () => {
  test("resolveRunConfig supplies systemPrompt + skillRoots when the caller omits them", async () => {
    const resolved: string[] = [];
    const svc = createAgentRunService({
      port: runPort,
      contextService: ctxService,
      idGen,
      ledgerResolver,
      resolveRunConfig: async ({ conversationId, agentMemberId }) => {
        resolved.push(`${conversationId}|${agentMemberId}`);
        return { systemPrompt: "soul\n\nUser context:\nuser", skillRoots: ["/packs/a"] };
      },
    });
    const { conversationId, agentMemberId } = freshFixture("cfg1");
    const result = await svc.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "run" },
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      idempotencyKey: `key-cfg1`,
    });
    expect(result.acquired).toBe(true);
    expect(resolved).toEqual([`${conversationId}|${agentMemberId}`]);
    expect(result.run?.systemPrompt).toBe("soul\n\nUser context:\nuser");
    expect(result.run?.skillRoots).toEqual(["/packs/a"]);
  });

  test("explicit caller values beat the resolver", async () => {
    const svc = createAgentRunService({
      port: runPort,
      contextService: ctxService,
      idGen,
      ledgerResolver,
      resolveRunConfig: async () => {
        throw new Error("must not be called");
      },
    });
    const { conversationId, agentMemberId } = freshFixture("cfg2");
    const result = await svc.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "run" },
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      idempotencyKey: `key-cfg2`,
      systemPrompt: "explicit",
      skillRoots: [],
      permissionMode: "auto",
    });
    expect(result.acquired).toBe(true);
    expect(result.run?.systemPrompt).toBe("explicit");
    expect(result.run?.skillRoots).toEqual([]);
  });
});

describe("Agent Run service", () => {
  test("lazy existing-member acquisition creates branch and run", async () => {
    const { conversationId, agentMemberId } = freshFixture("s1");
    const result = await runService.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "run" },
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      idempotencyKey: `key-s1`,
    });
    expect(result.acquired).toBe(true);
    expect(result.run?.status).toBe("running");
  });

  test("queued failure: second input on active branch is queued", async () => {
    const { conversationId, agentMemberId } = freshFixture("s2");
    await runService.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "first" },
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      idempotencyKey: `key-s2-1`,
    });
    const result2 = await runService.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "steer",
      message: { role: "user", text: "steer" },
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      idempotencyKey: `key-s2-2`,
    });
    expect(result2.acquired).toBe(false);
    expect(result2.queued).toBe(true);
  });

  test("model change affects next run snapshot", async () => {
    const { conversationId, agentMemberId } = freshFixture("s3");
    // First run
    const r1 = await runService.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "first" },
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      idempotencyKey: `key-s3-1`,
    });
    expect(r1.run?.modelRef.modelId).toBe("model-a");

    // Terminal the first run
    await runService.finalizeRun(r1.run!.runId, { status: "completed" });

    // Change model on the branch
    const branch = await ctxService.getOrCreateDefaultBranch(
      conversationId,
      agentMemberId,
      "coding_agent",
    );
    await ctxService.changeModel(branch.branchId, branch.revision, {
      backendKind: "coding_agent",
      modelId: "model-b",
    });

    // Second run should use the new model
    const r2 = await runService.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "second" },
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      idempotencyKey: `key-s3-2`,
    });
    expect(r2.run?.modelRef.modelId).toBe("model-b");
  });
});

describe("Agent Run cross-feature scenarios", () => {
  test("two agent members have isolated trees, branches, and runs", async () => {
    const conversationId = "conv-iso";
    conv.createConversation({ conversationId, triggerMode: "mention", createdAt: Date.now() });
    conv.addMember({
      memberId: "mem-iso-a",
      conversationId,
      kind: "agent",
      agentId: "ag-iso-a",
      displayName: "AgentA",
      joinedAt: Date.now(),
    });
    conv.addMember({
      memberId: "mem-iso-b",
      conversationId,
      kind: "agent",
      agentId: "ag-iso-b",
      displayName: "AgentB",
      joinedAt: Date.now(),
    });
    conv.appendLedgerEntry({
      conversationId,
      senderMemberId: "mem-iso-a",
      addressedTo: [],
      kind: "message",
      content: JSON.stringify({ role: "user", text: "msg-a" }),
      ts: Date.now(),
    });
    conv.appendLedgerEntry({
      conversationId,
      senderMemberId: "mem-iso-b",
      addressedTo: [],
      kind: "message",
      content: JSON.stringify({ role: "user", text: "msg-b" }),
      ts: Date.now(),
    });

    const r1 = await runService.enqueueAndAcquire({
      conversationId,
      agentMemberId: "mem-iso-a",
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "run-a" },
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      idempotencyKey: `key-iso-a`,
    });
    const r2 = await runService.enqueueAndAcquire({
      conversationId,
      agentMemberId: "mem-iso-b",
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "run-b" },
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      idempotencyKey: `key-iso-b`,
    });

    expect(r1.run?.agentMemberId).toBe("mem-iso-a");
    expect(r2.run?.agentMemberId).toBe("mem-iso-b");
    expect(r1.run?.runId).not.toBe(r2.run?.runId);
    expect(r1.run?.branchId).not.toBe(r2.run?.branchId);
  });

  test("stored Context entries contain ledgerSeq and stable entryId but no copied content", async () => {
    const { conversationId, agentMemberId } = freshFixture("ref");
    await runService.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "run" },
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      idempotencyKey: `key-ref`,
    });

    const entries = db
      .query(
        "SELECT entry_id, ledger_seq, payload FROM agent_context_entry WHERE type='ledger_message'",
      )
      .all() as { entry_id: string; ledger_seq: number; payload: string }[];

    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.entry_id).toBeTruthy();
      expect(e.ledger_seq).toBeGreaterThan(0);
      expect(e.payload).not.toContain("hello");
    }
  });
});
