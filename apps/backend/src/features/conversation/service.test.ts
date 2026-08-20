import { describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { createAgentContextService, sqliteAgentContextAdapter } from "../agent-context/index.js";
import type { AgentRunService } from "../agent-run/service.js";
import { sqliteConversationAdapter } from "./adapter-sqlite.js";
import { createConversationService, type TriggeredRun } from "./service.js";

const db = openDb(":memory:");
const port = sqliteConversationAdapter(db);

const contextPort = sqliteAgentContextAdapter(db, {
  ulid: () => `c-${Math.random().toString(36).slice(2, 8)}`,
});
const ledgerResolver = {
  async resolveMessage(conversationId: string, ledgerSeq: number) {
    const hit = port.getLedgerEntry(conversationId, ledgerSeq);
    return hit?.kind === "message" ? (hit.content as never) : null;
  },
};
const contextSvc = createAgentContextService({
  port: contextPort,
  idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
  ledgerResolver,
});

// Fake AgentRunService: records enqueues, controllable acquire/active state.
const enqueueCalls: Array<{
  conversationId: string;
  agentMemberId: string;
  mode: string;
  defaultModel: unknown;
  idempotencyKey: string;
  message: { text?: string };
}> = [];
const dispatchCalls: string[] = [];
let nextAcquired = true;
let activeRunId: string | null = null;
let runIdCounter = 0;
let knownRunConvId = "cid-1";
interface FakeQueuedInput {
  inputId: string;
  branchId: string;
  mode: string;
  text: string;
  status: "pending" | "delivered" | "cancelled";
  agentMemberId: string;
  createdAt: number;
}
const fakeInputs = new Map<string, FakeQueuedInput>();

function makeRunService(): AgentRunService {
  return {
    async enqueueAndAcquire(input) {
      enqueueCalls.push({
        conversationId: input.conversationId,
        agentMemberId: input.agentMemberId,
        mode: input.mode,
        idempotencyKey: input.idempotencyKey,
        defaultModel: input.defaultModel,
        message: input.message as { text?: string },
      });
      const runId = `run-${runIdCounter++}`;
      const inputId = `in-${runId}`;
      if (!nextAcquired) {
        fakeInputs.set(inputId, {
          inputId,
          branchId: "b",
          mode: input.mode,
          text: (input.message as { text?: string }).text ?? "",
          status: "pending",
          agentMemberId: input.agentMemberId,
          createdAt: Date.now(),
        });
      }
      return {
        acquired: nextAcquired,
        queued: !nextAcquired,
        replayed: false,
        run: nextAcquired
          ? ({
              runId,
              branchId: "b",
              conversationId: input.conversationId,
              agentMemberId: input.agentMemberId,
              modelRef: { backendKind: "oma", modelId: "m" },
              status: "running",
              idempotencyKey: input.idempotencyKey,
              terminalResult: null,
              configRevision: 1,
              productTools: null,
              createdAt: Date.now(),
              terminalAt: null,
            } as never)
          : undefined,
        inputId,
      };
    },
    async markInputAccepted(inputId) {
      return { inputId } as never;
    },
    async createPendingAction(runId, action) {
      return { runId, actionId: "a", ...action } as never;
    },
    async consumePendingAction(actionId) {
      return { action: { actionId } as never, runId: "r" };
    },
    async finalizeRun(runId) {
      return { runId } as never;
    },
    async getRun(runId) {
      if (runId === "run-known") {
        return { runId, conversationId: knownRunConvId, branchId: "b" } as never;
      }
      if (runId === "run-other") {
        return { runId, conversationId: "cid-other", branchId: "b" } as never;
      }
      return null;
    },
    async getActiveRun() {
      return activeRunId ? ({ runId: activeRunId, branchId: "b" } as never) : null;
    },
    async listInputs() {
      return [];
    },
    async getInput(inputId) {
      const i = fakeInputs.get(inputId);
      if (!i) return null;
      return {
        inputId: i.inputId,
        branchId: i.branchId,
        mode: i.mode,
        message: { role: "user", text: i.text },
        status: i.status,
        agentMemberId: i.agentMemberId,
      } as never;
    },
    async listPendingInputsForConversation() {
      return [...fakeInputs.values()]
        .filter((i) => i.status === "pending")
        .map(
          (i) =>
            ({
              inputId: i.inputId,
              branchId: i.branchId,
              mode: i.mode,
              message: { role: "user", text: i.text },
              status: i.status,
              agentMemberId: i.agentMemberId,
            }) as never,
        );
    },
    async updateInput(inputId, message) {
      const i = fakeInputs.get(inputId);
      if (i?.status !== "pending") return false;
      i.text = (message as { text: string }).text;
      return true;
    },
    async cancelInput(inputId) {
      const i = fakeInputs.get(inputId);
      if (i && i.status === "pending") i.status = "cancelled";
    },
    async hasActiveRunForConversations() {
      return false;
    },
    async listActiveRunsForConversations() {
      return [];
    },
  };
}

const runSvc = makeRunService();
const injectSteerCalls: Array<{ branchId: string; inputId: string }> = [];
const abortStaleCalls: string[] = [];
/** RunIds considered "live" (in-process child). DB-active alone is not live. */
let liveRunIds = new Set<string>();
/** RunIds with a dispatch in flight (pre-acceptance) on this process. */
let inflightRunIds = new Set<string>();
const svc = createConversationService({
  port,
  agentRunService: runSvc,
  dispatchRun: async (runId) => {
    dispatchCalls.push(runId);
  },
  injectSteer: async (branchId, input) => {
    injectSteerCalls.push({ branchId, inputId: input.inputId });
  },
  isLive: (runId) => liveRunIds.has(runId),
  isInflight: (runId) => inflightRunIds.has(runId),
  abortStaleRun: async (runId) => {
    abortStaleCalls.push(runId);
  },
  contextService: contextSvc,
  resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "fake/echo" }),
  maxConsecutiveAgentHops: () => 3,
  idGen: () => `id-${Math.random().toString(36).slice(2, 8)}`,
});

function setupConv(id: string) {
  try {
    port.createConversation({
      conversationId: id,
      triggerMode: "mention",
      createdAt: Date.now(),
    });
  } catch {
    /* already exists */
  }
  try {
    port.addMember({
      memberId: `mem-h1-${id}`,
      conversationId: id,
      kind: "human",
      userRef: "u-1",
      displayName: "Alice",
      joinedAt: Date.now(),
    });
  } catch {
    /* already exists */
  }
  try {
    port.addMember({
      memberId: `agent-1-${id}`,
      conversationId: id,
      kind: "agent",
      agentId: "a-1",
      displayName: "Agent One",
      joinedAt: Date.now(),
    });
  } catch {
    /* already exists */
  }
  return {
    humanMemberId: `mem-h1-${id}`,
    agentMemberId: `agent-1-${id}`,
  };
}

function messages(id: string) {
  return port.getLedgerEntries(id).filter((e) => e.kind === "message");
}

describe("conversation service (Agent Run cutover)", () => {
  test("human message is canonical History FIRST, then an acquired run is dispatched", async () => {
    const id = "cid-a";
    const { humanMemberId, agentMemberId } = setupConv(id);
    nextAcquired = true;
    activeRunId = null;
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;

    const result = await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: [agentMemberId],
      content: "hello agent",
    });

    expect(result.seq).toBeGreaterThan(0);
    expect(messages(id)).toHaveLength(1);
    expect(result.triggeredRuns).toEqual([{ agentMemberId, runId: "run-0", queued: false }]);
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]).toMatchObject({
      conversationId: id,
      agentMemberId,
      mode: "normal",
      idempotencyKey: `${id}:${result.seq}:${agentMemberId}`,
    });
    expect(dispatchCalls).toEqual(["run-0"]);
  });

  test("no trigger for empty addressedTo / non-mentioned agent", async () => {
    const id = "cid-b";
    const { humanMemberId, agentMemberId } = setupConv(id);
    enqueueCalls.length = 0;

    await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: [],
      content: "hello",
    });
    expect(enqueueCalls).toHaveLength(0);

    await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: ["someone-else"],
      content: "hello",
    });
    expect(enqueueCalls).toHaveLength(0);
    void agentMemberId;
  });

  test("busy branch with LIVE child -> steer mode, queued, no dispatch of a new run", async () => {
    const id = "cid-c";
    const { humanMemberId, agentMemberId } = setupConv(id);
    nextAcquired = false;
    activeRunId = "run-active";
    liveRunIds = new Set(["run-active"]);
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;
    abortStaleCalls.length = 0;

    const result = await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: [agentMemberId],
      content: "steer me",
    });

    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]!.mode).toBe("steer");
    expect(result.triggeredRuns).toEqual([{ agentMemberId, runId: "", queued: true }]);
    // steer belongs to the CURRENT run: injected into the live child, and
    // NO new run is dispatched (one Run / one child).
    expect(dispatchCalls).toHaveLength(0);
    expect(injectSteerCalls).toHaveLength(1);
    expect(injectSteerCalls[0]!.inputId).toBeTruthy();
  });

  test("postMessage modelOverride: same-kind honored, foreign-kind ignored", async () => {
    const id = "cid-mo";
    const { humanMemberId, agentMemberId } = setupConv(id);
    enqueueCalls.length = 0;

    await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: [agentMemberId],
      content: "use my model",
      modelOverride: { backendKind: "oma", modelId: "fake/other", reasoningEffort: "low" },
    });
    expect(enqueueCalls[0]!.defaultModel).toEqual({
      backendKind: "oma",
      modelId: "fake/other",
      reasoningEffort: "low",
    });

    enqueueCalls.length = 0;
    await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: [agentMemberId],
      content: "foreign kind",
      modelOverride: { backendKind: "claude_code", modelId: "claude-x" },
    });
    expect(enqueueCalls[0]!.defaultModel).toEqual({ backendKind: "oma", modelId: "fake/echo" });
  });
  test("zombie active run (DB active, no live child) -> abortStaleRun + fresh NORMAL run", async () => {
    const id = "cid-z";
    const { humanMemberId, agentMemberId } = setupConv(id);
    nextAcquired = true;
    activeRunId = "run-zombie";
    liveRunIds = new Set(); // DB-active but NOT live: a zombie
    inflightRunIds = new Set();
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;
    abortStaleCalls.length = 0;
    injectSteerCalls.length = 0;

    const result = await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: [agentMemberId],
      content: "hello again",
    });

    // The zombie is terminalized first, then the message becomes a NEW
    // normal Run - never silently dropped as a steer.
    expect(abortStaleCalls).toEqual(["run-zombie"]);
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]!.mode).toBe("normal");
    expect(dispatchCalls).toHaveLength(1);
    expect(injectSteerCalls).toHaveLength(0);
    expect(result.triggeredRuns[0]!.queued).toBe(false);
  });

  test("inflight run (pre-acceptance dispatch) is queued as follow_up, never aborted", async () => {
    const id = "cid-i";
    const { humanMemberId, agentMemberId } = setupConv(id);
    nextAcquired = false;
    activeRunId = "run-inflight";
    liveRunIds = new Set(); // no live child YET (pre-acceptance window)
    inflightRunIds = new Set(["run-inflight"]); // dispatch is in flight
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;
    abortStaleCalls.length = 0;
    injectSteerCalls.length = 0;

    const result = await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: [agentMemberId],
      content: "wait for it",
    });

    // The in-flight run is owned: queue the message as follow-up instead of
    // aborting it and racing a second child.
    expect(abortStaleCalls).toHaveLength(0);
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]!.mode).toBe("follow_up");
    expect(injectSteerCalls).toHaveLength(0);
    expect(result.triggeredRuns[0]!.queued).toBe(true);
  });

  test("explicit follow_up mode is honored even when idle", async () => {
    const id = "cid-d";
    const { humanMemberId, agentMemberId } = setupConv(id);
    nextAcquired = false;
    activeRunId = "run-active";
    enqueueCalls.length = 0;

    await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: [agentMemberId],
      content: "later",
      mode: "follow_up",
    });
    expect(enqueueCalls[0]!.mode).toBe("follow_up");
  });

  test("resets hop_count on human message, increments on agent message", async () => {
    const id = "cid-e";
    const { humanMemberId, agentMemberId } = setupConv(id);
    nextAcquired = true;
    activeRunId = null;
    port.updateHopCount(id, 5);

    await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: [],
      content: "reset",
    });
    expect(port.getConversation(id)!.hopCount).toBe(0);

    await svc.postMessage({
      conversationId: id,
      senderMemberId: agentMemberId,
      addressedTo: [humanMemberId],
      content: "agent msg",
    });
    expect(port.getConversation(id)!.hopCount).toBe(1);
  });

  test("hop-capped trigger writes a system message and does not enqueue", async () => {
    const id = "cid-f";
    const { agentMemberId } = setupConv(id);
    enqueueCalls.length = 0;
    port.updateHopCount(id, 10);

    await svc.postMessage({
      conversationId: id,
      senderMemberId: "agent-2",
      addressedTo: [agentMemberId],
      content: "capped",
    });
    expect(enqueueCalls).toHaveLength(0);
    expect(messages(id).some((m) => JSON.stringify(m.content).includes("上限"))).toBe(true);
  });

  test("mention cascade triggers mentioned agents with sourceRunId idempotency", async () => {
    const id = "cid-g";
    const { humanMemberId, agentMemberId } = setupConv(id);
    // add a second agent to be mentioned
    port.addMember({
      memberId: "agent-2",
      conversationId: id,
      kind: "agent",
      agentId: "a-2",
      displayName: "Second",
      joinedAt: Date.now(),
    });
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;
    nextAcquired = true;
    activeRunId = null;

    const message = { role: "assistant" as const, text: "please check @agent-2 for me" };
    const first = await svc.cascadeMentionedAgents({
      conversationId: id,
      sourceRunId: "run-src",
      senderMemberId: agentMemberId,
      message: message as never,
    });
    const second = await svc.cascadeMentionedAgents({
      conversationId: id,
      sourceRunId: "run-src",
      senderMemberId: agentMemberId,
      message: message as never,
    });

    const cascadeRuns = enqueueCalls.filter((c) => c.idempotencyKey === "run-src:agent-2");
    // replay of the same sourceRunId must produce the same single idempotent key
    expect(cascadeRuns).toHaveLength(2); // enqueued twice with the SAME key
    expect(new Set(cascadeRuns.map((c) => c.idempotencyKey)).size).toBe(1);
    expect(first.map((r: TriggeredRun) => r.agentMemberId)).toEqual(["agent-2"]);
    expect(second.map((r: TriggeredRun) => r.agentMemberId)).toEqual(["agent-2"]);
    void humanMemberId;
  });

  test("cascade skips the sender and non-mentioned agents", async () => {
    const id = "cid-h";
    const { agentMemberId } = setupConv(id);
    enqueueCalls.length = 0;

    await svc.cascadeMentionedAgents({
      conversationId: id,
      sourceRunId: "run-x",
      senderMemberId: agentMemberId,
      message: { role: "assistant" as const, text: "no mentions here" } as never,
    });
    expect(enqueueCalls).toHaveLength(0);
  });

  test("startNewConversationForSurface verifies the run owns the conversation", async () => {
    const id = "cid-i";
    const { humanMemberId, agentMemberId } = setupConv(id);
    await expect(
      svc.startNewConversationForSurface({
        oldConversationId: id,
        reason: "test",
        requestedByRunId: "run-missing",
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow("run not found");
    await expect(
      svc.startNewConversationForSurface({
        oldConversationId: id,
        reason: "test",
        requestedByRunId: "run-other",
        idempotencyKey: "k2",
      }),
    ).rejects.toThrow("does not belong");
    void humanMemberId;
    void agentMemberId;
  });

  test("startNewConversationForSurface creates the new conversation and control entry", async () => {
    const id = "cid-j";
    knownRunConvId = id;
    const { humanMemberId, agentMemberId } = setupConv(id);
    const result = await svc.startNewConversationForSurface({
      oldConversationId: id,
      reason: "fresh",
      title: "New chat",
      requestedByRunId: "run-known",
      idempotencyKey: "k3",
    });
    expect(result.newConversationId).toBeTruthy();
    const control = port.getLedgerEntries(id).find((e) => e.kind === "surface.control");
    expect(control).toBeTruthy();
    const newMembers = port.getMembers(result.newConversationId);
    expect(newMembers.some((m) => m.memberId === agentMemberId)).toBe(true);
    // only agent + lark human members are copied to the new conversation
    expect(newMembers.some((m) => m.memberId === humanMemberId)).toBe(false);
    expect(port.getConversation(result.newConversationId)!.title).toBe("New chat");
  });

  test("clear and compact are no-ops (no runtime sessions remain)", async () => {
    const id = "cid-k";
    setupConv(id);
    await svc.clearConversation(id);
    await svc.compactConversation(id);
    expect(port.getConversation(id)).toBeTruthy();
  });

  test("fork copies members and history up to fromSeq", async () => {
    const id = "cid-l";
    const { humanMemberId, agentMemberId } = setupConv(id);
    const { seq } = await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: [],
      content: "hello",
    });
    const forked = await svc.forkConversation({ conversationId: id, fromSeq: seq });
    expect(forked.newConversationId).toBeTruthy();
    const copied = port.getLedgerEntries(forked.newConversationId);
    expect(copied.filter((e) => e.kind === "message")).toHaveLength(1);
    expect(
      port.getMembers(forked.newConversationId).some((m) => m.memberId === agentMemberId),
    ).toBe(true);
  });

  test("undo soft-deletes the latest message and broadcasts an undo entry", async () => {
    const id = "cid-m";
    const { humanMemberId } = setupConv(id);
    await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: [],
      content: "to undo",
    });
    const result = await svc.undoMessages({ conversationId: id, count: 1 });
    expect(result.undoneSeqs).toHaveLength(1);
    expect(port.getLedgerEntries(id).some((e) => e.kind === "undo")).toBe(true);
  });

  // ─── Pending input queue (Composer queue area) ───

  test("explicit follow_up while LIVE child -> queued, NO steer injection (queue semantics)", async () => {
    const id = "cid-q1";
    const { humanMemberId, agentMemberId } = setupConv(id);
    nextAcquired = false;
    activeRunId = "run-live";
    liveRunIds = new Set(["run-live"]);
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;
    injectSteerCalls.length = 0;
    fakeInputs.clear();

    const result = await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: [agentMemberId],
      content: "queue me",
      mode: "follow_up",
    });

    expect(enqueueCalls[0]!.mode).toBe("follow_up");
    expect(result.triggeredRuns).toEqual([{ agentMemberId, runId: "", queued: true }]);
    expect(dispatchCalls).toHaveLength(0);
    expect(injectSteerCalls).toHaveLength(0);
    expect(fakeInputs.size).toBe(1);
  });

  test("listPendingInputs returns queued inputs; steerInput injects one", async () => {
    const id = "cid-q2";
    const { humanMemberId, agentMemberId } = setupConv(id);
    nextAcquired = false;
    activeRunId = "run-live";
    liveRunIds = new Set(["run-live"]);
    enqueueCalls.length = 0;
    injectSteerCalls.length = 0;
    fakeInputs.clear();

    await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: [agentMemberId],
      content: "first",
      mode: "follow_up",
    });
    await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: [agentMemberId],
      content: "second",
      mode: "follow_up",
    });

    const pending = await svc.listPendingInputs(id);
    expect(pending.map((p) => p.text)).toEqual(["first", "second"]);
    expect(pending[0]!.agentMemberId).toBe(agentMemberId);

    const inputId = pending[0]!.inputId;
    await svc.steerInput(inputId);
    expect(injectSteerCalls).toHaveLength(1);
    expect(injectSteerCalls[0]!.inputId).toBe(inputId);
  });

  test("updateInput edits pending text; cancelInput removes it from the queue", async () => {
    const id = "cid-q3";
    const { humanMemberId, agentMemberId } = setupConv(id);
    nextAcquired = false;
    activeRunId = "run-live";
    liveRunIds = new Set(["run-live"]);
    fakeInputs.clear();

    await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: [agentMemberId],
      content: "original",
      mode: "follow_up",
    });
    const inputId = (await svc.listPendingInputs(id))[0]!.inputId;

    expect(await svc.updateInput(inputId, "edited")).toBe(true);
    expect((await svc.listPendingInputs(id))[0]!.text).toBe("edited");

    await svc.cancelInput(inputId);
    expect(await svc.listPendingInputs(id)).toHaveLength(0);

    // edit after cancel is rejected (CAS pending-only)
    expect(await svc.updateInput(inputId, "too late")).toBe(false);
  });
});
