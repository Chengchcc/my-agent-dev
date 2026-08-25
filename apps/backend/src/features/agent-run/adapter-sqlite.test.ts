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
    const entry = conv.getLedgerEntry(conversationId, ledgerSeq);
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
  const agentId = `ag-run-${prefix}`;
  conv.createConversation({
    conversationId,
    agentId,
    createdAt: Date.now(),
  });
  // Add a ledger message
  conv.appendLedgerEntry({
    conversationId,
    senderMemberId: agentId,
    kind: "message",
    content: JSON.stringify({ role: "user", text: `hello-${prefix}` }),
    ts: Date.now(),
  });
  return { conversationId, agentId };
}

async function setupBranch(prefix: string) {
  const { conversationId, agentId } = freshFixture(prefix);
  const tree = await ctxPort.getOrCreateTree(conversationId);
  const branch = await ctxPort.getOrCreateDefaultBranch(tree.treeId, "oma");
  return { conversationId, agentId, branch };
}

afterAll(() => db.close());

describe("Agent Run: atomic acquire", () => {
  test("acquire succeeds on idle branch and creates active run", async () => {
    const { conversationId, agentId, branch } = await setupBranch("acq1");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "run me" },
      inputIdempotencyKey: `ikey-acq1`,
      runIdempotencyKey: `rkey-acq1`,
      deliveryIdempotencyKey: `dkey-acq1`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
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
    const { conversationId, agentId, branch } = await setupBranch("acq2");
    // First acquire
    await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-acq2-1`,
      runIdempotencyKey: `rkey-acq2-1`,
      deliveryIdempotencyKey: `dkey-acq2-1`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });

    // Second acquire: should queue
    const result2 = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "steer",
      message: { role: "user", text: "second" },
      inputIdempotencyKey: `ikey-acq2-2`,
      runIdempotencyKey: `rkey-acq2-2`,
      deliveryIdempotencyKey: `dkey-acq2-2`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
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

  test("acquire with new ledger refs appends context refs", async () => {
    const { conversationId, agentId, branch } = await setupBranch("acq4");

    // A user message lands in the ledger
    conv.appendLedgerEntry({
      conversationId,
      senderMemberId: "user-1",
      addressedTo: [agentId],
      kind: "message",
      content: JSON.stringify({ role: "user", text: "hello" }),
      ts: Date.now(),
    });

    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "hello" },
      inputIdempotencyKey: `ikey-acq4`,
      runIdempotencyKey: `rkey-acq4`,
      deliveryIdempotencyKey: `dkey-acq4`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    expect(result.acquired).toBe(true);

    // The new ledger message became a ledger_message ref in the branch.
    const entries = await ctxPort.listEntriesToLeaf(branch.branchId);
    expect(entries.filter((e) => e.type === "ledger_message").length).toBeGreaterThan(0);
  });

  test("duplicate input idempotency key returns queued", async () => {
    const { conversationId, agentId, branch } = await setupBranch("acq3");
    await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-dup`,
      runIdempotencyKey: `rkey-dup-1`,
      deliveryIdempotencyKey: `dkey-dup-1`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });

    // Same input idempotency key + same payload = replay
    const result2 = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" }, // same payload
      inputIdempotencyKey: `ikey-dup`, // same key
      runIdempotencyKey: `rkey-dup-1`,
      deliveryIdempotencyKey: `dkey-dup-1b`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    expect(result2.replayed).toBe(true);
    expect(result2.inputId).toBeTruthy();
  });
});

describe("Agent Run: pending input queue (composer)", () => {
  test("listPendingInputsForConversation joins branch->tree; get/update/cancel CAS", async () => {
    const { conversationId, agentId, branch } = await setupBranch("pq1");
    await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: "ikey-pq1-1",
      runIdempotencyKey: "rkey-pq1-1",
      deliveryIdempotencyKey: "dkey-pq1-1",
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });

    const q = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "follow_up",
      message: { role: "user", text: "queued" },
      inputIdempotencyKey: "ikey-pq1-2",
      runIdempotencyKey: "rkey-pq1-2",
      deliveryIdempotencyKey: "dkey-pq1-2",
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision + 1,
    });
    expect(q.queued).toBe(true);

    const pending = await runPort.listPendingInputsForConversation(conversationId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.mode).toBe("follow_up");
    expect((pending[0]!.message as { text: string }).text).toBe("queued");
    expect(pending[0]!.agentId).toBe(agentId);

    const input = await runPort.getInput(q.inputId);
    expect(input?.status).toBe("pending");
    expect(await runPort.updateInput(q.inputId, { role: "user", text: "edited" })).toBe(true);
    expect((await runPort.getInput(q.inputId))!.message as { text: string }).toMatchObject({
      text: "edited",
    });

    await runPort.cancelInput(q.inputId);
    expect(await runPort.listPendingInputsForConversation(conversationId)).toHaveLength(0);
    expect(await runPort.updateInput(q.inputId, { role: "user", text: "too late" })).toBe(false);
  });
});

describe("Agent Run: queue delivery", () => {
  test("claimInputForRun returns the run's delivering row", async () => {
    const { conversationId, agentId, branch } = await setupBranch("q1");
    await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-q1`,
      runIdempotencyKey: `rkey-q1`,
      deliveryIdempotencyKey: `dkey-q1`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });

    // The acquired input is in "delivering" state, bound to the run
    const active = await runPort.getActiveRun(branch.branchId);
    const claimed = await runPort.claimInputForRun(active!.runId);
    expect(claimed).toBeTruthy();
    expect(claimed?.input.status).toBe("delivering");
    expect(claimed?.runId).toBe(active!.runId);
  });

  test("markInputAccepted moves delivering to delivered", async () => {
    const { conversationId, agentId, branch } = await setupBranch("q2");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-q2`,
      runIdempotencyKey: `rkey-q2`,
      deliveryIdempotencyKey: `dkey-q2`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
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
    const { conversationId, agentId, branch } = await setupBranch("q2b");
    // First input acquires the run (delivering)
    const first = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-q2b-1`,
      runIdempotencyKey: `rkey-q2b-1`,
      deliveryIdempotencyKey: `dkey-q2b-1`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    expect(first.acquired).toBe(true);

    // Second input stays pending because the run slot is occupied
    const second = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "second" },
      inputIdempotencyKey: `ikey-q2b-2`,
      runIdempotencyKey: `rkey-q2b-2`,
      deliveryIdempotencyKey: `dkey-q2b-2`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
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
    const { conversationId, agentId, branch } = await setupBranch("q3");
    // Acquire (creates delivering item)
    const r1 = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-q3`,
      runIdempotencyKey: `rkey-q3`,
      deliveryIdempotencyKey: `dkey-q3`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });

    // Simulate restart: claimInputForRun should return the delivering item
    const active = await runPort.getActiveRun(branch.branchId);
    const claimed = await runPort.claimInputForRun(active!.runId);
    expect(claimed?.input.inputId).toBe(r1.inputId);
    expect(claimed?.input.status).toBe("delivering");
  });
});

describe("Agent Run: PendingAction consume-once", () => {
  test("create and consume pending action", async () => {
    const { conversationId, agentId, branch } = await setupBranch("pa1");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-pa1`,
      runIdempotencyKey: `rkey-pa1`,
      deliveryIdempotencyKey: `dkey-pa1`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
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
    const { conversationId, agentId, branch } = await setupBranch("pa2");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-pa2`,
      runIdempotencyKey: `rkey-pa2`,
      deliveryIdempotencyKey: `dkey-pa2`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
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
    const { conversationId, agentId, branch } = await setupBranch("pa3");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-pa3`,
      runIdempotencyKey: `rkey-pa3`,
      deliveryIdempotencyKey: `dkey-pa3`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
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
    const { conversationId, agentId, branch } = await setupBranch("term1");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-term1`,
      runIdempotencyKey: `rkey-term1`,
      deliveryIdempotencyKey: `dkey-term1`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
    });
    const runId = result.run!.runId;

    const finalized = await runPort.finalizeRun(runId, {
      status: "completed",
      messages: [{ role: "assistant", text: "done" }],
    });
    expect(finalized.status).toBe("completed");
    expect(finalized.terminalResult?.status).toBe("completed");
    expect(finalized.terminalAt).not.toBeNull();

    // Active slot released
    const active = await runPort.getActiveRun(branch.branchId);
    expect(active).toBeNull();
  });

  test("same terminal replay returns stored result", async () => {
    const { conversationId, agentId, branch } = await setupBranch("term2");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-term2`,
      runIdempotencyKey: `rkey-term2`,
      deliveryIdempotencyKey: `dkey-term2`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
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
    const { conversationId, agentId, branch } = await setupBranch("term3");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-term3`,
      runIdempotencyKey: `rkey-term3`,
      deliveryIdempotencyKey: `dkey-term3`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
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
    const { conversationId, agentId, branch } = await setupBranch("term4");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: `ikey-term4`,
      runIdempotencyKey: `rkey-term4`,
      deliveryIdempotencyKey: `dkey-term4`,
      defaultModel: { backendKind: "oma", modelId: "model-a" },
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

describe("Agent Run: Phase 5 config snapshot", () => {
  test("the Run persists systemPrompt + skillRoots frozen at creation", async () => {
    const { conversationId, agentId, branch } = await setupBranch("snap1");
    const result = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "go" },
      inputIdempotencyKey: "ikey-snap1",
      runIdempotencyKey: "rkey-snap1",
      deliveryIdempotencyKey: "dkey-snap1",
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
      systemPrompt: "frozen prompt",
      skillRoots: ["/skills/a", "/skills/b"],
    });
    expect(result.acquired).toBe(true);
    const run = result.run!;
    expect(run.systemPrompt).toBe("frozen prompt");
    expect(run.skillRoots).toEqual(["/skills/a", "/skills/b"]);
    // Recovery path re-reads the persisted snapshot.
    const reloaded = await runPort.getRun(run.runId);
    expect(reloaded?.systemPrompt).toBe("frozen prompt");
    expect(reloaded?.skillRoots).toEqual(["/skills/a", "/skills/b"]);
  });

  test("a queued input keeps its OWN config snapshot; acquireNextRun promotes with IT, never the previous run's config", async () => {
    const { conversationId, agentId, branch } = await setupBranch("snap2");
    // First run: model-a config.
    const first = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "normal",
      message: { role: "user", text: "first" },
      inputIdempotencyKey: "ikey-snap2-1",
      runIdempotencyKey: "rkey-snap2-1",
      deliveryIdempotencyKey: "dkey-snap2-1",
      defaultModel: { backendKind: "oma", modelId: "model-a" },
      configRevision: 1,
      expectedRevision: branch.revision,
      systemPrompt: "first prompt",
    });
    expect(first.acquired).toBe(true);

    // Queued input with a DIFFERENT request-time config.
    const queued = await runPort.enqueueAndAcquire({
      conversationId,
      agentId,
      branchId: branch.branchId,
      mode: "follow_up",
      message: { role: "user", text: "second" },
      inputIdempotencyKey: "ikey-snap2-2",
      runIdempotencyKey: "rkey-snap2-2",
      deliveryIdempotencyKey: "dkey-snap2-2",
      defaultModel: { backendKind: "oma", modelId: "model-b" },
      configRevision: 7,
      workspace: { root: "/pinned-other", access: "read_only" },
      systemPrompt: "second prompt",
      skillRoots: ["/skills/loop"],
      expectedRevision: branch.revision + 1,
    });
    expect(queued.queued).toBe(true);

    // Settle the first run, then promote: the new run must use the QUEUED
    // input's snapshot (model-b / revision 7 / pinned workspace), NOT the
    // first run's (model-a / 1 / null).
    await runPort.finalizeRun(first.run!.runId, { status: "completed" });
    const second = await runPort.acquireNextRun(branch.branchId);
    expect(second).not.toBeNull();
    expect(second!.modelRef).toEqual({ backendKind: "oma", modelId: "model-b" });
    expect(second!.configRevision).toBe(7);
    expect(second!.workspace).toEqual({ root: "/pinned-other", access: "read_only" });
    expect(second!.systemPrompt).toBe("second prompt");
    expect(second!.skillRoots).toEqual(["/skills/loop"]);
  });

  test("listIdleBranchesWithPendingInputs returns FIFO branches whose pending input never became a Run", async () => {
    const a = await setupBranch("idle-a");
    const b = await setupBranch("idle-b");
    // Branch b: first input acquires a run, second queues (pending, older).
    const bFirst = await runPort.enqueueAndAcquire({
      conversationId: b.conversationId,
      agentId: b.agentId,
      branchId: b.branch.branchId,
      mode: "normal",
      message: { role: "user", text: "b-first" },
      inputIdempotencyKey: "ikey-idle-b1",
      runIdempotencyKey: "rkey-idle-b1",
      deliveryIdempotencyKey: "dkey-idle-b1",
      defaultModel: { backendKind: "oma", modelId: "m" },
      configRevision: 1,
      expectedRevision: b.branch.revision,
    });
    expect(bFirst.acquired).toBe(true);
    await runPort.enqueueAndAcquire({
      conversationId: b.conversationId,
      agentId: b.agentId,
      branchId: b.branch.branchId,
      mode: "follow_up",
      message: { role: "user", text: "b-pending" },
      inputIdempotencyKey: "ikey-idle-b2",
      runIdempotencyKey: "rkey-idle-b2",
      deliveryIdempotencyKey: "dkey-idle-b2",
      defaultModel: { backendKind: "oma", modelId: "m" },
      configRevision: 1,
      expectedRevision: b.branch.revision + 1,
    });
    // Branch a: first input acquires a run, second queues (pending, newer).
    const aFirst = await runPort.enqueueAndAcquire({
      conversationId: a.conversationId,
      agentId: a.agentId,
      branchId: a.branch.branchId,
      mode: "normal",
      message: { role: "user", text: "a-first" },
      inputIdempotencyKey: "ikey-idle-a1",
      runIdempotencyKey: "rkey-idle-a1",
      deliveryIdempotencyKey: "dkey-idle-a1",
      defaultModel: { backendKind: "oma", modelId: "m" },
      configRevision: 1,
      expectedRevision: a.branch.revision,
    });
    expect(aFirst.acquired).toBe(true);
    await runPort.enqueueAndAcquire({
      conversationId: a.conversationId,
      agentId: a.agentId,
      branchId: a.branch.branchId,
      mode: "normal",
      message: { role: "user", text: "a-pending" },
      inputIdempotencyKey: "ikey-idle-a2",
      runIdempotencyKey: "rkey-idle-a2",
      deliveryIdempotencyKey: "dkey-idle-a2",
      defaultModel: { backendKind: "oma", modelId: "m" },
      configRevision: 1,
      expectedRevision: a.branch.revision + 1,
    });
    // A steer input never counts as a pending promotable input.
    await runPort.enqueueAndAcquire({
      conversationId: a.conversationId,
      agentId: a.agentId,
      branchId: a.branch.branchId,
      mode: "steer",
      message: { role: "user", text: "steer" },
      inputIdempotencyKey: "ikey-idle-a3",
      runIdempotencyKey: "rkey-idle-a3",
      deliveryIdempotencyKey: "dkey-idle-a3",
      defaultModel: { backendKind: "oma", modelId: "m" },
      configRevision: 1,
      expectedRevision: a.branch.revision + 1,
    });

    // Both branches have pending inputs; FIFO order by oldest pending seq
    // (older foreign branches from earlier tests may precede them).
    const idle = await runPort.listIdleBranchesWithPendingInputs();
    expect(idle).toContain(b.branch.branchId);
    expect(idle).toContain(a.branch.branchId);
    expect(idle.indexOf(b.branch.branchId)).toBeLessThan(idle.indexOf(a.branch.branchId));

    // The busy branch's pending input is NOT promoted while its run is live.
    expect(await runPort.acquireNextRun(a.branch.branchId)).toBeNull();
    // Settle b's run: b's pending input (its OWN snapshot) promotes now.
    await runPort.finalizeRun(bFirst.run!.runId, { status: "completed" });
    const promoted = await runPort.acquireNextRun(b.branch.branchId);
    expect(promoted).not.toBeNull();
    const after = await runPort.listIdleBranchesWithPendingInputs();
    expect(after).not.toContain(b.branch.branchId);
    expect(after).toContain(a.branch.branchId);
  });
});
