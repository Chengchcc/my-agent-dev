import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteAgentContextAdapter } from "../agent-context/adapter-sqlite.js";
import type {
  AgentContextPort,
  IdGenerator,
  LedgerMessageResolver,
} from "../agent-context/ports.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import { sqliteAgentRunAdapter } from "./adapter-sqlite.js";
import { AgentRunConflictError, PendingActionAlreadyConsumedError } from "./domain.js";
import type { AgentRunPort } from "./ports.js";

const db = openDb(":memory:");
const conv = sqliteConversationAdapter(db);
const ctxPort: AgentContextPort = sqliteAgentContextAdapter(db);
const idGen: IdGenerator = { ulid: () => crypto.randomUUID().replace(/-/g, "").slice(0, 26) };
const ledgerResolver: LedgerMessageResolver = {
  async resolveMessage(conversationId, ledgerSeq) {
    const entries = conv.getLedgerEntries(conversationId, { sinceSeq: ledgerSeq - 1 });
    const entry = entries.find((e) => e.seq === ledgerSeq);
    if (!entry) return null;
    return entry.content as never;
  },
};
const runPort: AgentRunPort = sqliteAgentRunAdapter(db, {
  contextPort: ctxPort,
  ledgerResolver,
  idGen,
});

function freshFixture(prefix: string) {
  const conversationId = `conv-run-${prefix}`;
  const agentMemberId = `mem-run-${prefix}`;
  conv.createConversation({ conversationId, triggerMode: "mention", createdAt: Date.now() });
  conv.addMember({
    memberId: agentMemberId,
    conversationId,
    kind: "agent",
    agentId: `ag-run-${prefix}`,
    displayName: `RunAgent-${prefix}`,
    joinedAt: Date.now(),
  });
  // Add a ledger message
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

async function setupBranch(prefix: string) {
  const { conversationId, agentMemberId } = freshFixture(prefix);
  const tree = await ctxPort.getOrCreateTree(conversationId, agentMemberId);
  const branch = await ctxPort.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
  return { conversationId, agentMemberId, branch };
}

afterAll(() => db.close());

describe("Agent Run: atomic acquire", () => {
  test("acquire succeeds on idle branch and creates active run", async () => {
    const { conversationId, agentMemberId, branch } = await setupBranch("acq1");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "run me" },
      inputIdempotencyKey: `ikey-acq1`,
      runIdempotencyKey: `rkey-acq1`,
      deliveryIdempotencyKey: `dkey-acq1`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    expect(result.acquired).toBe(true);
    expect(result.queued).toBe(false);
    expect(result.run).toBeTruthy();
    expect(result.run?.status).toBe("running");
    expect(result.run?.branchId).toBe(branch.branchId);
  });

  test("acquire on active branch queues without modifying context", async () => {
    const { conversationId, agentMemberId, branch } = await setupBranch("acq2");
    // First acquire
    await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-acq2-1`,
      runIdempotencyKey: `rkey-acq2-1`,
      deliveryIdempotencyKey: `dkey-acq2-1`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });

    // Second acquire: should queue
    const result2 = await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "steer",
      message: { role: "user", text: "second" },
      inputIdempotencyKey: `ikey-acq2-2`,
      runIdempotencyKey: `rkey-acq2-2`,
      deliveryIdempotencyKey: `dkey-acq2-2`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision + 1,
    });
    expect(result2.acquired).toBe(false);
    expect(result2.queued).toBe(true);
    expect(result2.run).toBeUndefined();

    // Only one active run
    const active = await runPort.getActiveRun(branch.branchId);
    expect(active).toBeTruthy();
  });

  test("acquire with new ledger refs marks existing binding stale", async () => {
    const { conversationId, agentMemberId, branch } = await setupBranch("acq4");
    // Existing backend session binding claims to be active + synced at rev 1
    await ctxPort.upsertBinding({
      backendSessionId: "bs-acq4",
      branchId: branch.branchId,
      backendKind: "coding_agent",
      syncedEntryId: null,
      syncedRevision: 1,
      state: "active",
      updatedAt: Date.now(),
    });

    // A user message lands in the ledger
    conv.appendLedgerEntry({
      conversationId,
      senderMemberId: "user-1",
      addressedTo: [agentMemberId],
      kind: "message",
      content: JSON.stringify({ role: "user", text: "hello" }),
      ts: Date.now(),
    });

    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "hello" },
      inputIdempotencyKey: `ikey-acq4`,
      runIdempotencyKey: `rkey-acq4`,
      deliveryIdempotencyKey: `dkey-acq4`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    expect(result.acquired).toBe(true);

    // The binding must no longer claim synced state: context changed underneath it
    const binding = await ctxPort.getBinding(branch.branchId);
    expect(binding?.state).toBe("stale");
  });

  test("duplicate input idempotency key returns queued", async () => {
    const { conversationId, agentMemberId, branch } = await setupBranch("acq3");
    await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-dup`,
      runIdempotencyKey: `rkey-dup-1`,
      deliveryIdempotencyKey: `dkey-dup-1`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });

    // Same input idempotency key + same payload = replay
    const result2 = await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" }, // same payload
      inputIdempotencyKey: `ikey-dup`, // same key
      runIdempotencyKey: `rkey-dup-1`,
      deliveryIdempotencyKey: `dkey-dup-1b`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    expect(result2.replayed).toBe(true);
    expect(result2.inputId).toBeTruthy();
  });
});

describe("Agent Run: queue delivery", () => {
  test("claimNextInput returns delivering row before pending", async () => {
    const { conversationId, agentMemberId, branch } = await setupBranch("q1");
    await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-q1`,
      runIdempotencyKey: `rkey-q1`,
      deliveryIdempotencyKey: `dkey-q1`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });

    // The acquired input is in "delivering" state
    const claimed = await runPort.claimNextInput(branch.branchId);
    expect(claimed).toBeTruthy();
    expect(claimed?.input.status).toBe("delivering");
  });

  test("markInputAccepted moves delivering to delivered", async () => {
    const { conversationId, agentMemberId, branch } = await setupBranch("q2");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-q2`,
      runIdempotencyKey: `rkey-q2`,
      deliveryIdempotencyKey: `dkey-q2`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });

    const accepted = await runPort.markInputAccepted(result.inputId);
    expect(accepted.status).toBe("delivered");

    // Idempotent: second accept returns same row
    const accepted2 = await runPort.markInputAccepted(result.inputId);
    expect(accepted2.status).toBe("delivered");
  });

  test("markInputAccepted rejects inputs not in delivering state", async () => {
    const { conversationId, agentMemberId, branch } = await setupBranch("q2b");
    // First input acquires the run (delivering)
    const first = await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-q2b-1`,
      runIdempotencyKey: `rkey-q2b-1`,
      deliveryIdempotencyKey: `dkey-q2b-1`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    expect(first.acquired).toBe(true);

    // Second input stays pending because the run slot is occupied
    const second = await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "second" },
      inputIdempotencyKey: `ikey-q2b-2`,
      runIdempotencyKey: `rkey-q2b-2`,
      deliveryIdempotencyKey: `dkey-q2b-2`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    expect(second.acquired).toBe(false);
    expect(second.queued).toBe(true);

    // Accepting a pending input must fail loudly, not silently return it
    expect(runPort.markInputAccepted(second.inputId!)).rejects.toThrow(/cannot be accepted/);

    // The delivering input is still accept-able (recovery path)
    const acceptedFirst = await runPort.markInputAccepted(first.inputId!);
    expect(acceptedFirst.status).toBe("delivered");
  });

  test("restart recovery: delivering item reclaimed before pending", async () => {
    const { conversationId, agentMemberId, branch } = await setupBranch("q3");
    // Acquire (creates delivering item)
    const r1 = await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-q3`,
      runIdempotencyKey: `rkey-q3`,
      deliveryIdempotencyKey: `dkey-q3`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });

    // Simulate restart: claimNextInput should return the delivering item
    const claimed = await runPort.claimNextInput(branch.branchId);
    expect(claimed?.input.inputId).toBe(r1.inputId);
    expect(claimed?.input.status).toBe("delivering");
  });
});

describe("Agent Run: PendingAction consume-once", () => {
  test("create and consume pending action", async () => {
    const { conversationId, agentMemberId, branch } = await setupBranch("pa1");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-pa1`,
      runIdempotencyKey: `rkey-pa1`,
      deliveryIdempotencyKey: `dkey-pa1`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const runId = result.run!.runId;

    // Create pending action
    const action = await runPort.createPendingAction(runId, {
      actionId: `action-pa1`,
      kind: "approval",
      payload: { question: "ok?" },
    });
    expect(action.status).toBe("pending");

    // Run should be waiting
    const waitingRun = await runPort.getRun(runId);
    expect(waitingRun?.status).toBe("waiting");

    // Consume
    // Consume
    const consumed = await runPort.consumePendingAction(
      `action-pa1`,
      { actionId: `action-pa1`, response: { approved: true } },
      "resp-pa1",
    );
    expect(consumed.action.status).toBe("resolved");

    // Run should be back to running
    const runningRun = await runPort.getRun(runId);
    expect(runningRun?.status).toBe("running");
  });
  test("same response idempotency key returns stored result", async () => {
    const { conversationId, agentMemberId, branch } = await setupBranch("pa2");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-pa2`,
      runIdempotencyKey: `rkey-pa2`,
      deliveryIdempotencyKey: `dkey-pa2`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const runId = result.run!.runId;

    await runPort.createPendingAction(runId, {
      actionId: `action-pa2`,
      kind: "approval",
      payload: {},
    });

    await runPort.consumePendingAction(
      `action-pa2`,
      { actionId: `action-pa2`, response: { approved: true } },
      "resp-pa2",
    );

    // Replay with same key
    const replay = await runPort.consumePendingAction(
      `action-pa2`,
      { actionId: `action-pa2`, response: { approved: true } },
      "resp-pa2",
    );
    expect(replay.action.status).toBe("resolved");
  });

  test("conflicting response throws", async () => {
    const { conversationId, agentMemberId, branch } = await setupBranch("pa3");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-pa3`,
      runIdempotencyKey: `rkey-pa3`,
      deliveryIdempotencyKey: `dkey-pa3`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const runId = result.run!.runId;

    await runPort.createPendingAction(runId, {
      actionId: `action-pa3`,
      kind: "approval",
      payload: {},
    });

    await runPort.consumePendingAction(
      `action-pa3`,
      { actionId: `action-pa3`, response: { approved: true } },
      "resp-pa3-a",
    );

    // Different response with different key
    expect(
      runPort.consumePendingAction(
        `action-pa3`,
        { actionId: `action-pa3`, response: { approved: false } },
        "resp-pa3-b",
      ),
    ).rejects.toThrow(PendingActionAlreadyConsumedError);
  });
});

describe("Agent Run: terminal CAS", () => {
  test("finalizeRun sets terminal status and result", async () => {
    const { conversationId, agentMemberId, branch } = await setupBranch("term1");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-term1`,
      runIdempotencyKey: `rkey-term1`,
      deliveryIdempotencyKey: `dkey-term1`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const runId = result.run!.runId;

    const finalized = await runPort.finalizeRun(runId, {
      status: "completed",
      output: { role: "assistant", text: "done" },
    });
    expect(finalized.status).toBe("completed");
    expect(finalized.terminalResult?.status).toBe("completed");
    expect(finalized.terminalAt).not.toBeNull();

    // Active slot released
    const active = await runPort.getActiveRun(branch.branchId);
    expect(active).toBeNull();
  });

  test("same terminal replay returns stored result", async () => {
    const { conversationId, agentMemberId, branch } = await setupBranch("term2");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-term2`,
      runIdempotencyKey: `rkey-term2`,
      deliveryIdempotencyKey: `dkey-term2`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const runId = result.run!.runId;

    const outcome = { status: "completed" as const };
    await runPort.finalizeRun(runId, outcome);
    const replay = await runPort.finalizeRun(runId, outcome);
    expect(replay.status).toBe("completed");
  });

  test("conflicting terminal outcome throws", async () => {
    const { conversationId, agentMemberId, branch } = await setupBranch("term3");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-term3`,
      runIdempotencyKey: `rkey-term3`,
      deliveryIdempotencyKey: `dkey-term3`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const runId = result.run!.runId;

    await runPort.finalizeRun(runId, { status: "completed" });
    expect(runPort.finalizeRun(runId, { status: "failed", error: "oops" })).rejects.toThrow(
      AgentRunConflictError,
    );
  });

  test("commit_failed keeps active slot and terminal result", async () => {
    const { conversationId, agentMemberId, branch } = await setupBranch("term4");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-term4`,
      runIdempotencyKey: `rkey-term4`,
      deliveryIdempotencyKey: `dkey-term4`,
      defaultModel: { backendKind: "coding_agent", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const runId = result.run!.runId;

    // Simulate commit_failed: terminal result saved but status is commit_failed
    db.exec(
      "UPDATE agent_run SET status='commit_failed', terminal_result=?, terminal_at=? WHERE run_id=?",
      [
        JSON.stringify({ status: "completed", output: { role: "assistant", text: "done" } }),
        Date.now(),
        runId,
      ],
    );

    // commit_failed is still active
    const active = await runPort.getActiveRun(branch.branchId);
    expect(active?.status).toBe("commit_failed");
    expect(active?.terminalResult?.status).toBe("completed");
  });
});
