import { describe, expect, test } from "bun:test";
import { conv, ctxPort, runPort, setupBranch } from "./adapter-sqlite.harness.js";

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

    const accepted2 = await runPort.markInputAccepted(result.inputId);
    expect(accepted2.status).toBe("delivered");
  });

  test("markInputAccepted rejects inputs not in delivering state", async () => {
    const { conversationId, agentId, branch } = await setupBranch("q2b");
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

    expect(runPort.markInputAccepted(second.inputId!)).rejects.toThrow(/cannot be accepted/);

    const acceptedFirst = await runPort.markInputAccepted(first.inputId!);
    expect(acceptedFirst.status).toBe("delivered");
  });

  test("restart recovery: delivering item reclaimed before pending", async () => {
    const { conversationId, agentId, branch } = await setupBranch("q3");
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

    const active = await runPort.getActiveRun(branch.branchId);
    const claimed = await runPort.claimInputForRun(active!.runId);
    expect(claimed?.input.inputId).toBe(r1.inputId);
    expect(claimed?.input.status).toBe("delivering");
  });
});
