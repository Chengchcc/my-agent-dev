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
    const entries = port.getLedgerEntries(conversationId, { sinceSeq: ledgerSeq });
    const hit = entries.find((e) => e.seq === ledgerSeq);
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
  idempotencyKey: string;
  message: { text?: string };
}> = [];
const dispatchCalls: string[] = [];
let nextAcquired = true;
let activeRunId: string | null = null;
let runIdCounter = 0;
let knownRunConvId = "cid-1";

function makeRunService(): AgentRunService {
  return {
    async enqueueAndAcquire(input) {
      enqueueCalls.push({
        conversationId: input.conversationId,
        agentMemberId: input.agentMemberId,
        mode: input.mode,
        idempotencyKey: input.idempotencyKey,
        message: input.message as { text?: string },
      });
      const runId = `run-${runIdCounter++}`;
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
              modelRef: { backendKind: "coding_agent", modelId: "m" },
              status: "running",
              idempotencyKey: input.idempotencyKey,
              terminalResult: null,
              configRevision: 1,
              productTools: null,
              createdAt: Date.now(),
              terminalAt: null,
            } as never)
          : undefined,
        inputId: `in-${runId}`,
      };
    },
    async claimNextInput() {
      return null;
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
  };
}

const runSvc = makeRunService();
const svc = createConversationService({
  port,
  agentRunService: runSvc,
  dispatchRun: async (runId) => {
    dispatchCalls.push(runId);
  },
  contextService: contextSvc,
  resolveDefaultModel: async () => ({ backendKind: "coding_agent", modelId: "fake/echo" }),
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

  test("busy branch -> steer mode, queued, no dispatch of a new run", async () => {
    const id = "cid-c";
    const { humanMemberId, agentMemberId } = setupConv(id);
    nextAcquired = false;
    activeRunId = "run-active";
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;

    const result = await svc.postMessage({
      conversationId: id,
      senderMemberId: humanMemberId,
      addressedTo: [agentMemberId],
      content: "steer me",
    });

    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]!.mode).toBe("steer");
    expect(result.triggeredRuns).toEqual([{ agentMemberId, runId: "", queued: true }]);
    expect(dispatchCalls).toHaveLength(0);
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
});
