import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteAgentContextAdapter } from "../agent-context/adapter-sqlite.js";
import type { IdGenerator, LedgerMessageResolver } from "../agent-context/ports.js";
import { createAgentContextService } from "../agent-context/service.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import { sqliteAgentRunAdapter } from "./adapter-sqlite.js";
import { AgentDisabledError, createAgentRunService } from "./service.js";

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
  const agentId = `ag-svc-${prefix}`;
  conv.createConversation({
    conversationId,
    agentId,
    triggerMode: "mention",
    createdAt: Date.now(),
  });
  conv.appendLedgerEntry({
    conversationId,
    senderMemberId: agentId,
    kind: "message",
    content: JSON.stringify({ role: "user", text: `hello-${prefix}` }),
    ts: Date.now(),
  });
  return { conversationId, agentId };
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
      resolveRunConfig: async ({ conversationId, agentId }) => {
        resolved.push(`${conversationId}|${agentId}`);
        return { systemPrompt: "soul\n\nUser context:\nuser", skillRoots: ["/packs/a"] };
      },
    });
    const { conversationId, agentId } = freshFixture("cfg1");
    const result = await svc.enqueueAndAcquire({
      conversationId,
      agentId,
      backendKind: "oma",
      mode: "normal",
      message: { role: "user", text: "run" },
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      idempotencyKey: `key-cfg1`,
    });
    expect(result.acquired).toBe(true);
    expect(resolved).toEqual([`${conversationId}|${agentId}`]);
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
    const { conversationId, agentId } = freshFixture("cfg2");
    const result = await svc.enqueueAndAcquire({
      conversationId,
      agentId,
      backendKind: "oma",
      mode: "normal",
      message: { role: "user", text: "run" },
      defaultModel: { backendKind: "oma", modelId: "model-a" },
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

  test("resolveAgentEnabled=false rejects before any branch/queue mutation", async () => {
    const { conversationId, agentId } = freshFixture("disabled");
    const svc = createAgentRunService({
      port: runPort,
      contextService: ctxService,
      idGen,
      ledgerResolver,
      resolveAgentEnabled: async () => false,
    });
    await expect(
      svc.enqueueAndAcquire({
        conversationId,
        agentId,
        backendKind: "oma",
        mode: "normal",
        message: { role: "user", text: "nope" },
        defaultModel: { backendKind: "oma", modelId: "model-a" },
        configRevision: 1,
        idempotencyKey: "key-disabled",
      }),
    ).rejects.toBeInstanceOf(AgentDisabledError);
  });
});

describe("Agent Run service", () => {
  test("lazy acquisition creates branch and run", async () => {
    const { conversationId, agentId } = freshFixture("s1");
    const result = await runService.enqueueAndAcquire({
      conversationId,
      agentId,
      backendKind: "oma",
      mode: "normal",
      message: { role: "user", text: "run" },
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      idempotencyKey: `key-s1`,
    });
    expect(result.acquired).toBe(true);
    expect(result.run?.status).toBe("running");
  });

  test("queued failure: second input on active branch is queued", async () => {
    const { conversationId, agentId } = freshFixture("s2");
    await runService.enqueueAndAcquire({
      conversationId,
      agentId,
      backendKind: "oma",
      mode: "normal",
      message: { role: "user", text: "first" },
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      idempotencyKey: `key-s2-1`,
    });
    const result2 = await runService.enqueueAndAcquire({
      conversationId,
      agentId,
      backendKind: "oma",
      mode: "steer",
      message: { role: "user", text: "steer" },
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      idempotencyKey: `key-s2-2`,
    });
    expect(result2.acquired).toBe(false);
    expect(result2.queued).toBe(true);
  });

  test("model change affects next run snapshot", async () => {
    const { conversationId, agentId } = freshFixture("s3");
    // First run
    const r1 = await runService.enqueueAndAcquire({
      conversationId,
      agentId,
      backendKind: "oma",
      mode: "normal",
      message: { role: "user", text: "first" },
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      idempotencyKey: `key-s3-1`,
    });
    expect(r1.run?.modelRef.modelId).toBe("model-a");

    // Terminal the first run
    await runService.finalizeRun(r1.run!.runId, { status: "completed" });

    // Change model on the branch
    const branch = await ctxService.getOrCreateDefaultBranch(conversationId, "oma");
    await ctxService.changeModel(branch.branchId, branch.revision, {
      backendKind: "oma",
      modelId: "model-b",
    });

    // Second run should use the new model
    const r2 = await runService.enqueueAndAcquire({
      conversationId,
      agentId,
      backendKind: "oma",
      mode: "normal",
      message: { role: "user", text: "second" },
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      idempotencyKey: `key-s3-2`,
    });
    expect(r2.run?.modelRef.modelId).toBe("model-b");
  });
});

describe("Agent Run cross-feature scenarios", () => {
  test("stored Context entries contain ledgerSeq and stable entryId but no copied content", async () => {
    const { conversationId, agentId } = freshFixture("ref");
    await runService.enqueueAndAcquire({
      conversationId,
      agentId,
      backendKind: "oma",
      mode: "normal",
      message: { role: "user", text: "run" },
      defaultModel: { backendKind: "oma", modelId: "model-a" },
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
