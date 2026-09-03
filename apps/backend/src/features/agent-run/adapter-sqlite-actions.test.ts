import { describe, expect, test } from "bun:test";
import { db, runPort, setupBranch } from "./adapter-sqlite.harness.js";
import { AgentRunConflictError, PendingActionAlreadyConsumedError } from "./domain.js";

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

    const action = await runPort.createPendingAction(runId, {
      actionId: `action-pa1`,
      kind: "approval",
      payload: { question: "ok?" },
    });
    expect(action.status).toBe("pending");

    const waitingRun = await runPort.getRun(runId);
    expect(waitingRun?.status).toBe("waiting");

    const consumed = await runPort.consumePendingAction(
      `action-pa1`,
      { actionId: `action-pa1`, response: { approved: true } },
      "resp-pa1",
    );
    expect(consumed.action.status).toBe("resolved");

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

    db.exec(
      "UPDATE agent_run SET status='commit_failed', terminal_result=?, terminal_at=? WHERE run_id=?",
      [
        JSON.stringify({ status: "completed", output: { role: "assistant", text: "done" } }),
        Date.now(),
        runId,
      ],
    );

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
    const reloaded = await runPort.getRun(run.runId);
    expect(reloaded?.systemPrompt).toBe("frozen prompt");
    expect(reloaded?.skillRoots).toEqual(["/skills/a", "/skills/b"]);
  });

  test("a queued input keeps its OWN config snapshot; acquireNextRun promotes with IT, never the previous run's config", async () => {
    const { conversationId, agentId, branch } = await setupBranch("snap2");
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

    const idle = await runPort.listIdleBranchesWithPendingInputs();
    expect(idle).toContain(b.branch.branchId);
    expect(idle).toContain(a.branch.branchId);
    expect(idle.indexOf(b.branch.branchId)).toBeLessThan(idle.indexOf(a.branch.branchId));

    expect(await runPort.acquireNextRun(a.branch.branchId)).toBeNull();
    await runPort.finalizeRun(bFirst.run!.runId, { status: "completed" });
    const promoted = await runPort.acquireNextRun(b.branch.branchId);
    expect(promoted).not.toBeNull();
    const after = await runPort.listIdleBranchesWithPendingInputs();
    expect(after).not.toContain(b.branch.branchId);
    expect(after).toContain(a.branch.branchId);
  });
});
