import { describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { createAgentContextService, sqliteAgentContextAdapter } from "../agent-context/index.js";
import type { AgentRunService } from "../agent-run/service.js";
import { sqliteConversationAdapter } from "./adapter-sqlite.js";
import { createConversationService } from "./service.js";

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
  agentId: string;
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
  agentId: string;
  createdAt: number;
}
const fakeInputs = new Map<string, FakeQueuedInput>();

function makeRunService(): AgentRunService {
  return {
    async enqueueAndAcquire(input) {
      enqueueCalls.push({
        conversationId: input.conversationId,
        agentId: input.agentId,
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
          agentId: input.agentId,
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
              agentId: input.agentId,
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
        agentId: i.agentId,
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
              agentId: i.agentId,
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
  idGen: () => `id-${Math.random().toString(36).slice(2, 8)}`,
});

function setupConv(id: string) {
  try {
    port.createConversation({
      conversationId: id,
      agentId: "a-1",
      triggerMode: "mention",
      createdAt: Date.now(),
    });
  } catch {
    /* already exists */
  }
  return { agentId: "a-1" };
}

function messages(id: string) {
  return port.getLedgerEntries(id).filter((e) => e.kind === "message");
}

describe("conversation service (Agent Run cutover)", () => {
  test("human message is canonical History FIRST, then an acquired run is dispatched", async () => {
    const id = "cid-a";
    const { agentId } = setupConv(id);
    nextAcquired = true;
    activeRunId = null;
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;

    const result = await svc.postMessage({ conversationId: id, content: "hello agent" });

    expect(result.seq).toBeGreaterThan(0);
    expect(messages(id)).toHaveLength(1);
    expect(result.triggeredRuns).toEqual([{ agentId, runId: "run-0", queued: false }]);
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]).toMatchObject({
      conversationId: id,
      agentId,
      mode: "normal",
      idempotencyKey: `${id}:${result.seq}:${agentId}`,
    });
    expect(dispatchCalls).toEqual(["run-0"]);
  });

  test("explicit addressedTo without the conversation's agent does not trigger", async () => {
    const id = "cid-b";
    setupConv(id);
    enqueueCalls.length = 0;

    await svc.postMessage({ conversationId: id, addressedTo: [], content: "hello" });
    expect(enqueueCalls).toHaveLength(0);

    await svc.postMessage({
      conversationId: id,
      addressedTo: ["someone-else"],
      content: "hello",
    });
    expect(enqueueCalls).toHaveLength(0);
  });

  test("busy branch with LIVE child -> steer mode, queued, no dispatch of a new run", async () => {
    const id = "cid-c";
    const { agentId } = setupConv(id);
    nextAcquired = false;
    activeRunId = "run-active";
    liveRunIds = new Set(["run-active"]);
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;
    abortStaleCalls.length = 0;

    const result = await svc.postMessage({ conversationId: id, content: "steer me" });

    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]!.mode).toBe("steer");
    expect(result.triggeredRuns).toEqual([{ agentId, runId: "", queued: true }]);
    // steer belongs to the CURRENT run: injected into the live child, and
    // NO new run is dispatched (one Run / one child).
    expect(dispatchCalls).toHaveLength(0);
    expect(injectSteerCalls).toHaveLength(1);
    expect(injectSteerCalls[0]!.inputId).toBeTruthy();
  });

  test("postMessage modelOverride: same-kind honored, foreign-kind ignored", async () => {
    const id = "cid-mo";
    setupConv(id);
    enqueueCalls.length = 0;

    await svc.postMessage({
      conversationId: id,
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
      content: "foreign kind",
      modelOverride: { backendKind: "claude_code", modelId: "claude-x" },
    });
    expect(enqueueCalls[0]!.defaultModel).toEqual({ backendKind: "oma", modelId: "fake/echo" });
  });

  test("zombie active run (DB active, no live child) -> abortStaleRun + fresh NORMAL run", async () => {
    const id = "cid-z";
    setupConv(id);
    nextAcquired = true;
    activeRunId = "run-zombie";
    liveRunIds = new Set(); // DB-active but NOT live: a zombie
    inflightRunIds = new Set();
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;
    abortStaleCalls.length = 0;
    injectSteerCalls.length = 0;

    const result = await svc.postMessage({ conversationId: id, content: "hello again" });

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
    setupConv(id);
    nextAcquired = false;
    activeRunId = "run-inflight";
    liveRunIds = new Set(); // no live child YET (pre-acceptance window)
    inflightRunIds = new Set(["run-inflight"]); // dispatch is in flight
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;
    abortStaleCalls.length = 0;
    injectSteerCalls.length = 0;

    const result = await svc.postMessage({ conversationId: id, content: "wait for it" });

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
    setupConv(id);
    nextAcquired = false;
    activeRunId = "run-active";
    enqueueCalls.length = 0;

    await svc.postMessage({ conversationId: id, content: "later", mode: "follow_up" });
    expect(enqueueCalls[0]!.mode).toBe("follow_up");
  });

  test("startNewConversationForSurface verifies the run owns the conversation", async () => {
    const id = "cid-s1";
    setupConv(id);
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
  });

  test("startNewConversationForSurface creates the new conversation and control entry", async () => {
    const id = "cid-j";
    knownRunConvId = id;
    setupConv(id);
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
    // 1:1: the new conversation keeps the same agent binding.
    expect(port.getConversation(result.newConversationId)!.agentId).toBe("a-1");
    expect(port.getConversation(result.newConversationId)!.title).toBe("New chat");
  });

  test("clear and compact are no-ops (no runtime sessions remain)", async () => {
    const id = "cid-k";
    setupConv(id);
    await svc.clearConversation(id);
    await svc.compactConversation(id);
    expect(port.getConversation(id)).toBeTruthy();
  });

  test("fork copies the agent binding and history up to fromSeq", async () => {
    const id = "cid-l";
    setupConv(id);
    nextAcquired = true;
    activeRunId = null;
    const { seq } = await svc.postMessage({ conversationId: id, content: "hello" });
    const forked = await svc.forkConversation({ conversationId: id, fromSeq: seq });
    expect(forked.newConversationId).toBeTruthy();
    const copied = port.getLedgerEntries(forked.newConversationId);
    expect(copied.filter((e) => e.kind === "message")).toHaveLength(1);
    expect(port.getConversation(forked.newConversationId)!.agentId).toBe("a-1");
  });

  test("undo soft-deletes the latest message and broadcasts an undo entry", async () => {
    const id = "cid-m";
    setupConv(id);
    nextAcquired = true;
    activeRunId = null;
    await svc.postMessage({ conversationId: id, content: "to undo" });
    const result = await svc.undoMessages({ conversationId: id, count: 1 });
    expect(result.undoneSeqs).toHaveLength(1);
    expect(port.getLedgerEntries(id).some((e) => e.kind === "undo")).toBe(true);
  });

  // ─── Pending input queue (Composer queue area) ───

  test("explicit follow_up while LIVE child -> queued, NO steer injection (queue semantics)", async () => {
    const id = "cid-q1";
    const { agentId } = setupConv(id);
    nextAcquired = false;
    activeRunId = "run-live";
    liveRunIds = new Set(["run-live"]);
    enqueueCalls.length = 0;
    dispatchCalls.length = 0;
    injectSteerCalls.length = 0;
    fakeInputs.clear();

    const result = await svc.postMessage({
      conversationId: id,
      content: "queue me",
      mode: "follow_up",
    });

    expect(enqueueCalls[0]!.mode).toBe("follow_up");
    expect(result.triggeredRuns).toEqual([{ agentId, runId: "", queued: true }]);
    expect(dispatchCalls).toHaveLength(0);
    expect(injectSteerCalls).toHaveLength(0);
    expect(fakeInputs.size).toBe(1);
  });

  test("listPendingInputs returns queued inputs; steerInput injects one", async () => {
    const id = "cid-q2";
    const { agentId } = setupConv(id);
    nextAcquired = false;
    activeRunId = "run-live";
    liveRunIds = new Set(["run-live"]);
    enqueueCalls.length = 0;
    injectSteerCalls.length = 0;
    fakeInputs.clear();

    await svc.postMessage({ conversationId: id, content: "first", mode: "follow_up" });
    await svc.postMessage({ conversationId: id, content: "second", mode: "follow_up" });

    const pending = await svc.listPendingInputs(id);
    expect(pending.map((p) => p.text)).toEqual(["first", "second"]);
    expect(pending[0]!.agentId).toBe(agentId);

    const inputId = pending[0]!.inputId;
    await svc.steerInput(inputId);
    expect(injectSteerCalls).toHaveLength(1);
    expect(injectSteerCalls[0]!.inputId).toBe(inputId);
  });

  test("updateInput edits pending text; cancelInput removes it from the queue", async () => {
    const id = "cid-q3";
    setupConv(id);
    nextAcquired = false;
    activeRunId = "run-live";
    liveRunIds = new Set(["run-live"]);
    fakeInputs.clear();

    await svc.postMessage({ conversationId: id, content: "original", mode: "follow_up" });
    const inputId = (await svc.listPendingInputs(id))[0]!.inputId;

    expect(await svc.updateInput(inputId, "edited")).toBe(true);
    expect((await svc.listPendingInputs(id))[0]!.text).toBe("edited");

    await svc.cancelInput(inputId);
    expect(await svc.listPendingInputs(id)).toHaveLength(0);

    // edit after cancel is rejected (CAS pending-only)
    expect(await svc.updateInput(inputId, "too late")).toBe(false);
  });
});
