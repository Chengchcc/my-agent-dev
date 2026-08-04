import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodingAgentBackend,
  CodingAgentClient,
  CodingAgentModelCatalog,
} from "@my-agent-team/adapter-coding-agent";
import type { BackendRunOutcome, RunEventEnvelope } from "@my-agent-team/agent-backend";
import { openDb } from "../../infra/sqlite/db.js";
import { createAgentContextService, sqliteAgentContextAdapter } from "../agent-context/index.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import { sqliteProductToolCallAdapter } from "../product-tools/adapter-sqlite.js";
import { createProductToolsService } from "../product-tools/service.js";
import { sqliteAgentRunAdapter } from "./adapter-sqlite.js";
import type { AgentRun } from "./domain.js";
import { createAgentRunExecutionService, decideExecutionPath } from "./execution.js";
import { createAgentRunService } from "./service.js";

// ─── Fake Coding Agent daemon (HTTP-level; real CodingAgentClient/Backend) ─

interface FakeDaemonOptions {
  /** Fail the first start attempt (acceptance-before crash). */
  failFirstStart?: boolean;
  outcomeDelayMs?: number;
}

function encodeSSE(events: readonly RunEventEnvelope[]): string {
  return events
    .map((e) => `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");
}

function createFakeDaemon(opts: FakeDaemonOptions = {}) {
  const startCalls: Array<{ idempotencyKey: string; runId: string }> = [];
  const resumeCalls: Array<{ backendSessionId: string; runId: string }> = [];
  const sendCalls: Array<{ runId: string; mode: string }> = [];
  let startAttempts = 0;
  let sidSeq = 0;
  const sessions = new Map<string, string>(); // idempotencyKey -> backendSessionId
  const readyAt = new Map<string, number>();
  const eventsByRun = new Map<string, RunEventEnvelope[]>();

  const eventsFor = (): RunEventEnvelope[] => [
    { id: 1, type: "agent_start", data: {} },
    { id: 2, type: "message_update", data: { text: "working" } },
    { id: 3, type: "agent_end", data: { status: "completed" } },
  ];

  let verifyManifestAtAccept: ((runId: string) => void) | null = null;
  // Bun's `typeof fetch` carries static members (preconnect) that an arrow
  // function cannot satisfy; the assertion is intentional - this fake only
  // implements the callable.
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;

    if (method === "POST" && path.endsWith("/start")) {
      startAttempts++;
      const key = String(body?.idempotencyKey);
      const runId = String((body?.run as { runId?: string })?.runId);
      startCalls.push({ idempotencyKey: key, runId });
      verifyManifestAtAccept?.(runId);
      if (opts.failFirstStart && startAttempts === 1) {
        return Response.json(
          { code: "internal", message: "simulated start failure" },
          { status: 500 },
        );
      }
      let sid = sessions.get(key);
      if (!sid) {
        sid = `sid-${++sidSeq}`;
        sessions.set(key, sid);
      }
      readyAt.set(runId, Date.now() + (opts.outcomeDelayMs ?? 60));
      eventsByRun.set(runId, eventsFor());
      return Response.json({ backendSessionId: sid, runId });
    }
    if (method === "POST" && path.includes("/resume")) {
      const runId = String((body?.run as { runId?: string })?.runId);
      const sid = path.split("/")[4] ?? "sid-resume";
      resumeCalls.push({ backendSessionId: sid, runId });
      readyAt.set(runId, Date.now() + (opts.outcomeDelayMs ?? 60));
      eventsByRun.set(runId, eventsFor());
      return Response.json({ backendSessionId: sid, runId });
    }
    if (method === "POST" && path.includes("/send")) {
      const runId = String(body?.runId);
      const mode = String(body?.mode);
      sendCalls.push({ runId, mode });
      readyAt.set(runId, Date.now() + (opts.outcomeDelayMs ?? 60));
      eventsByRun.set(runId, eventsFor());
      return Response.json({ backendSessionId: "sid-send", runId, commandId: "c", accepted: true });
    }
    if (method === "GET" && path.includes("/events")) {
      const runId = path.split("/")[3]!;
      const lastId = Number((init?.headers as Record<string, string>)?.["Last-Event-ID"] ?? -1);
      const evs = (eventsByRun.get(runId) ?? []).filter((e) => e.id > lastId);
      return new Response(encodeSSE(evs), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (method === "GET" && path.includes("/outcome")) {
      const runId = path.split("/")[3]!;
      const ready = readyAt.get(runId) ?? 0;
      if (Date.now() < ready) {
        return new Response(null, { status: 202 });
      }
      const outcome: BackendRunOutcome = {
        status: "completed",
        output: { role: "assistant", text: "done" },
      };
      return Response.json({ runId, ...outcome });
    }
    if (method === "GET" && path === "/v1/models") {
      return Response.json({
        backendKind: "coding_agent",
        models: [
          {
            id: "fake/echo",
            displayName: "Fake Echo",
            reasoning: false,
            inputModalities: ["text"],
            contextWindow: 200_000,
            maxOutputTokens: 8192,
            available: true,
          },
        ],
      });
    }
    if (method === "POST" && path.includes("/stop")) {
      return Response.json({ stopped: true });
    }
    if (method === "DELETE") {
      return Response.json({ closed: true });
    }
    return Response.json({ code: "not_found", message: path }, { status: 404 });
  };

  return {
    // the fake only implements the callable, not Bun's static fetch members
    fetchImpl: fetchImpl as typeof fetch,
    startCalls,
    resumeCalls,
    sendCalls,
    setVerifyManifest: (fn: (runId: string) => void) => {
      verifyManifestAtAccept = fn;
    },
  };
}

// ─── Test harness ──────────────────────────────────────────────────────

let dataDir: string;
let db: ReturnType<typeof openDb>;
let convPort: ReturnType<typeof sqliteConversationAdapter>;
let contextPort: ReturnType<typeof sqliteAgentContextAdapter>;
let backend: ReturnType<typeof createAgentRunService>;
let runPort: ReturnType<typeof sqliteAgentRunAdapter>;

const conversationId = "conv-1";
const agentMemberId = "mem-1";

function makeDeps(
  fakeDaemon: ReturnType<typeof createFakeDaemon>,
  runPortOverride?: ReturnType<typeof sqliteAgentRunAdapter>,
) {
  const activeRunPort = runPortOverride ?? runPort;
  const ledgerResolver = {
    async resolveMessage(cid: string, seq: number) {
      const entries = convPort.getLedgerEntries(cid);
      const hit = entries.find((e) => e.seq === seq);
      return hit ? (hit.content as never) : null;
    },
  };
  const realClient = new CodingAgentClient({
    baseUrl: "http://fake",
    authToken: "t",
    fetchImpl: fakeDaemon.fetchImpl,
  });
  const execution = createAgentRunExecutionService({
    runPort: activeRunPort,
    contextPort,
    ledgerResolver,
    backend: new CodingAgentBackend(realClient),
    modelCatalog: new CodingAgentModelCatalog(realClient),
    idGen: { ulid: () => `id-${Math.random().toString(36).slice(2, 12)}` },
    resolveWorkspace: async () => ({ root: dataDir, access: "read_write" }),
    productToolsEntrypoint: "sse:http://127.0.0.1:1/mcp",
  });
  return execution;
}

async function waitForTerminal(runId: string): Promise<AgentRun> {
  for (let i = 0; i < 100; i++) {
    const run = await runPort.getRun(runId);
    if (
      run &&
      (run.status === "completed" ||
        run.status === "failed" ||
        run.status === "aborted" ||
        run.status === "commit_failed")
    ) {
      return run;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} never reached terminal`);
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "phase4-exec-"));
  db = openDb(`${dataDir}/backend.db`);
  convPort = sqliteConversationAdapter(db);
  contextPort = sqliteAgentContextAdapter(db, {
    ulid: () => `ctx-${Math.random().toString(36).slice(2, 10)}`,
  });
  const ledgerResolver = {
    async resolveMessage(cid: string, seq: number) {
      const entries = convPort.getLedgerEntries(cid);
      const hit = entries.find((e) => e.seq === seq);
      return hit ? (hit.content as never) : null;
    },
  };
  runPort = sqliteAgentRunAdapter(db, {
    contextPort,
    ledgerResolver,
    idGen: { ulid: () => `run-${Math.random().toString(36).slice(2, 10)}` },
  });
  const contextSvc = createAgentContextService({
    port: contextPort,
    idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 10)}` },
    ledgerResolver,
  });
  backend = createAgentRunService({
    port: runPort,
    contextService: contextSvc,
    idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 10)}` },
    ledgerResolver,
  });

  convPort.createConversation({ conversationId, createdAt: Date.now() });
  convPort.addMember({
    memberId: agentMemberId,
    conversationId,
    kind: "agent",
    agentId: "a1",
    joinedAt: Date.now(),
  });
  // Tree + default branch exist before enqueue (service creates them lazily;
  // here we create them explicitly so the branch id is known).
  const tree = await contextPort.getOrCreateTree(conversationId, agentMemberId);
  await contextPort.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("agent run execution", () => {
  test("dispatch completes a run: input delivered once, terminal commit writes history/context/binding", async () => {
    const fake = createFakeDaemon();
    const execution = makeDeps(fake);

    const acquired = await backend.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "hello" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "ikey-1",
    });
    expect(acquired.acquired).toBe(true);
    const runId = acquired.run!.runId;

    const events: string[] = [];
    const sub = execution.subscribe(runId);
    const collector = (async () => {
      for await (const ev of sub) events.push(ev.type);
    })();

    await execution.dispatch(runId);
    const run = await waitForTerminal(runId);
    expect(run.status).toBe("completed");
    await collector;

    // input delivered exactly once
    const inputs = await runPort.listInputs(run.branchId);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.status).toBe("delivered");

    // exactly one assistant message in the ledger
    const ledger = convPort.getLedgerEntries(conversationId);
    const messages = ledger.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content as unknown).toMatchObject({ role: "assistant", text: "done" });

    // exactly one ledger_message ref in context
    const entries = await contextPort.listEntriesToLeaf(run.branchId);
    const refs = entries.filter((e) => e.type === "ledger_message");
    expect(refs).toHaveLength(1);

    // binding synced to the new leaf
    const binding = await contextPort.getBinding(run.branchId);
    expect(binding?.state).toBe("active");
    expect(binding?.syncedEntryId).toBe(refs[0]!.entryId);
    expect(binding?.backendSessionId).toBeTruthy();

    // subscriber saw the transient events
    expect(events).toContain("text_delta"); // adapter-mapped transient events

    // replay of the same dispatch must not rewrite product facts
    await execution.dispatch(runId);
    const ledgerAfter = convPort
      .getLedgerEntries(conversationId)
      .filter((e) => e.kind === "message");
    expect(ledgerAfter).toHaveLength(1);
  }, 15_000);

  test("acceptance-before failure keeps the input delivering; recover redelivers with the same idempotency", async () => {
    const fake = createFakeDaemon({ failFirstStart: true });
    const execution = makeDeps(fake);

    const acquired = await backend.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "hi" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "ikey-recover",
    });
    const runId = acquired.run!.runId;

    await expect(execution.dispatch(runId)).rejects.toThrow();

    // input still delivering (not delivered)
    const inputs = await runPort.listInputs(acquired.run!.branchId);
    expect(inputs[0]!.status).toBe("delivering");

    // recover redelivers with the same runId/inputId/idempotency
    await execution.recover();
    const run = await waitForTerminal(runId);
    expect(run.status).toBe("completed");

    // the fake daemon saw the SAME idempotency key on both attempts
    expect(fake.startCalls).toHaveLength(2);
    expect(fake.startCalls[0]!.idempotencyKey).toBe(fake.startCalls[1]!.idempotencyKey);
    const delivered = (await runPort.listInputs(run.branchId))[0]!;
    expect(delivered.status).toBe("delivered");
  }, 15_000);

  test("two inputs on one run: queue order preserved, both delivered, only the final outcome commits", async () => {
    const fake = createFakeDaemon();
    const execution = makeDeps(fake);

    const first = await backend.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "first" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "ikey-2a",
    });
    const runId = first.run!.runId;

    // follow_up while active: queued, not acquired
    const second = await backend.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "follow_up",
      message: { role: "user", text: "second" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "ikey-2b",
    });
    expect(second.acquired).toBe(false);
    expect(second.queued).toBe(true);

    await execution.dispatch(runId);
    const run = await waitForTerminal(runId);
    expect(run.status).toBe("completed");

    const inputs = await runPort.listInputs(run.branchId);
    expect(inputs).toHaveLength(2);
    expect(inputs.map((i) => i.status)).toEqual(["delivered", "delivered"]);
    expect(inputs[0]!.message.text).toBe("first");
    expect(inputs[1]!.message.text).toBe("second");

    // the second input went through send (follow_up) on the live segment
    expect(fake.sendCalls).toHaveLength(1);
    expect(fake.sendCalls[0]!.mode).toBe("follow_up");

    // only ONE assistant message committed (the final outcome)
    const messages = convPort.getLedgerEntries(conversationId).filter((e) => e.kind === "message");
    expect(messages).toHaveLength(1);
  }, 15_000);

  test("commit transaction failure -> commit_failed, no partial facts, stale binding; retry commits once without re-executing", async () => {
    // A dedicated adapter with the test-only commit hook that throws at the
    // END of the commit transaction - proving the whole thing rolls back.
    const hookRunPort = sqliteAgentRunAdapter(db, {
      contextPort,
      ledgerResolver: {
        async resolveMessage(cid: string, seq: number) {
          const hit = convPort.getLedgerEntries(cid).find((e) => e.seq === seq);
          return hit ? (hit.content as never) : null;
        },
      },
      idGen: { ulid: () => `h-${Math.random().toString(36).slice(2, 8)}` },
      commitTestHook: () => {
        throw new Error("injected commit failure");
      },
    });
    const fake = createFakeDaemon();
    const execution = makeDeps(fake, hookRunPort);
    const acquired = await backend.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "commit fail" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "ikey-commitfail",
    });
    const runId = acquired.run!.runId;
    const activeBranchId = acquired.run!.branchId;

    await execution.dispatch(runId);
    const run = await waitForTerminal(runId);
    expect(run?.status).toBe("commit_failed");
    expect(run?.terminalResult?.status).toBe("completed");

    // ZERO partial Product facts: the rolled-back transaction left no
    // assistant ledger message and no context ref.
    expect(
      convPort.getLedgerEntries(conversationId).filter((e) => e.kind === "message"),
    ).toHaveLength(0);
    expect(
      (await contextPort.listEntriesToLeaf(activeBranchId)).filter(
        (e) => e.type === "ledger_message",
      ),
    ).toHaveLength(0);
    // branch revision untouched
    const branch = await contextPort.getBranch(activeBranchId);
    expect(branch?.revision).toBe(2); // acquire bumped 1->2; the failed commit added nothing

    // no active binding survived (this run never had one; a pre-existing
    // binding would have gone stale in the failCommit transaction)
    const binding = await contextPort.getBinding(activeBranchId);
    expect(binding).toBeNull();

    // retry replays ONLY the stored outcome - the Backend is never called
    // again - and the commit succeeds exactly once.
    const startsBefore = fake.startCalls.length;
    // retry goes through the NORMAL adapter (no fault hook) - the stored
    // outcome is the only input, so the commit succeeds.
    const exec2 = createAgentRunExecutionService({
      runPort,
      contextPort,
      ledgerResolver: {
        async resolveMessage(cid: string, seq: number) {
          const hit = convPort.getLedgerEntries(cid).find((e) => e.seq === seq);
          return hit ? (hit.content as never) : null;
        },
      },
      backend: new CodingAgentBackend(
        new CodingAgentClient({
          baseUrl: "http://fake",
          authToken: "t",
          fetchImpl: fake.fetchImpl,
        }),
      ),
      modelCatalog: new CodingAgentModelCatalog(
        new CodingAgentClient({
          baseUrl: "http://fake",
          authToken: "t",
          fetchImpl: fake.fetchImpl,
        }),
      ),
      idGen: { ulid: () => `z-${Math.random().toString(36).slice(2, 8)}` },
      resolveWorkspace: async () => ({ root: dataDir, access: "read_write" }),
      productToolsEntrypoint: "sse:http://127.0.0.1:1/mcp",
    });
    await exec2.retryTerminalCommit(runId);
    const done = await hookRunPort.getRun(runId);
    expect(done?.status).toBe("completed");
    expect(fake.startCalls.length).toBe(startsBefore);
    expect(
      convPort.getLedgerEntries(conversationId).filter((e) => e.kind === "message"),
    ).toHaveLength(1);
  }, 15_000);

  test("CONCURRENT retryTerminalCommit commits exactly once", async () => {
    const fake = createFakeDaemon();
    const execution = makeDeps(fake);
    const acquired = await backend.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "concurrent retry" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "ikey-ccretry",
    });
    const runId = acquired.run!.runId;
    // The Backend already finished; only the Product commit failed.
    const outcome = {
      status: "completed" as const,
      output: { role: "assistant" as const, text: "final" },
    };
    await runPort.failCommit(runId, outcome);

    await Promise.all([execution.retryTerminalCommit(runId), execution.retryTerminalCommit(runId)]);
    const run = await runPort.getRun(runId);
    expect(run?.status).toBe("completed");
    // the runId commit identity allows exactly ONE final Message
    const ledger = convPort.getLedgerEntries(conversationId);
    const messages = ledger.filter(
      (e) => e.kind === "message" && e.senderMemberId === agentMemberId,
    );
    expect(messages).toHaveLength(1);
    // and the Backend was never re-invoked
    expect(fake.startCalls).toHaveLength(0);
  }, 15_000);

  test("failCommit transitions an ACTIVE binding to stale in the same transaction", async () => {
    const acquired = await backend.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "stale" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "ikey-stale",
    });
    const runId = acquired.run!.runId;
    // an established, ACTIVE binding (as if a previous run had synced)
    await contextPort.upsertBinding({
      branchId: acquired.run!.branchId,
      backendSessionId: "sid-old",
      backendKind: "coding_agent",
      syncedEntryId: "e-old",
      syncedRevision: 2,
      state: "active",
      updatedAt: Date.now(),
    });
    await runPort.failCommit(runId, {
      status: "completed",
      output: { role: "assistant", text: "x" },
    });
    const binding = await contextPort.getBinding(acquired.run!.branchId);
    expect(binding?.state).toBe("stale");
    expect(binding?.backendSessionId).toBe("sid-old");
    const run = await runPort.getRun(runId);
    expect(run?.status).toBe("commit_failed");
  });

  test("queue order survives a real DB reopen + recover (two inputs, stable seq)", async () => {
    // A file-backed database: enqueue two inputs, close the DB, reopen it
    // with fresh adapters, and recover - the redelivery order must match the
    // original insertion order.
    const dir = mkdtempSync(join(tmpdir(), "phase4-restart-"));
    const db1 = openDb(`${dir}/backend.db`);
    const conv1 = sqliteConversationAdapter(db1);
    const ctx1 = sqliteAgentContextAdapter(db1, {
      ulid: () => `c-${Math.random().toString(36).slice(2, 8)}`,
    });
    const resolver1 = {
      async resolveMessage(cid: string, seq: number) {
        const hit = conv1.getLedgerEntries(cid).find((e) => e.seq === seq);
        return hit ? (hit.content as never) : null;
      },
    };
    const runPort1 = sqliteAgentRunAdapter(db1, {
      contextPort: ctx1,
      ledgerResolver: resolver1,
      idGen: { ulid: () => `r-${Math.random().toString(36).slice(2, 8)}` },
    });
    const ctxSvc1 = createAgentContextService({
      port: ctx1,
      idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
      ledgerResolver: resolver1,
    });
    const backend1 = createAgentRunService({
      port: runPort1,
      contextService: ctxSvc1,
      idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
      ledgerResolver: resolver1,
    });
    conv1.createConversation({ conversationId: "c-restart", createdAt: Date.now() });
    conv1.addMember({
      memberId: "m-restart",
      conversationId: "c-restart",
      kind: "agent",
      agentId: "a",
      joinedAt: Date.now(),
    });
    const tree1 = await ctx1.getOrCreateTree("c-restart", "m-restart");
    await ctx1.getOrCreateDefaultBranch(tree1.treeId, "coding_agent");

    const first = await backend1.enqueueAndAcquire({
      conversationId: "c-restart",
      agentMemberId: "m-restart",
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "first" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "restart-1",
    });
    const second = await backend1.enqueueAndAcquire({
      conversationId: "c-restart",
      agentMemberId: "m-restart",
      backendKind: "coding_agent",
      mode: "follow_up",
      message: { role: "user", text: "second" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "restart-2",
    });
    const runId = first.run!.runId;
    db1.close();

    // "restart": reopen the SAME file with fresh adapters.
    const db2 = openDb(`${dir}/backend.db`);
    const conv2 = sqliteConversationAdapter(db2);
    const ctx2 = sqliteAgentContextAdapter(db2, {
      ulid: () => `c-${Math.random().toString(36).slice(2, 8)}`,
    });
    const resolver2 = {
      async resolveMessage(cid: string, seq: number) {
        const hit = conv2.getLedgerEntries(cid).find((e) => e.seq === seq);
        return hit ? (hit.content as never) : null;
      },
    };
    const runPort2 = sqliteAgentRunAdapter(db2, {
      contextPort: ctx2,
      ledgerResolver: resolver2,
      idGen: { ulid: () => `r-${Math.random().toString(36).slice(2, 8)}` },
    });
    const ctxSvc2 = createAgentContextService({
      port: ctx2,
      idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
      ledgerResolver: resolver2,
    });
    const backend2 = createAgentRunService({
      port: runPort2,
      contextService: ctxSvc2,
      idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
      ledgerResolver: resolver2,
    });

    const branch2 = await ctx2.getBranch(first.run!.branchId);
    const claimed1 = await backend2.claimNextInput(branch2!.branchId);
    // the first input was left delivering by the crash; the recovery claim
    // returns it, and once accepted the NEXT claim must yield the second
    // input in original order
    expect(claimed1?.input.message.text).toBe("first");
    await backend2.markInputAccepted(claimed1!.input.inputId);
    const claimed2 = await backend2.claimNextInput(branch2!.branchId);
    expect(claimed2?.input.message.text).toBe("second");
    expect(claimed1?.runId).toBe(runId);
    // the follow-up stayed queued (pending) for the SAME run's loop
    expect(second.queued).toBe(true);
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a retain before the terminal commit keeps the branch chain intact (no orphan)", async () => {
    // Sequential retain + commit: the commit re-reads the branch (revision
    // advanced by the retain) and appends the final ref on top. The CAS in
    // commitCompletedRun protects the CONCURRENT case across connections;
    // this proves the sequential chain never orphans an entry.
    const acquired = await backend.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "retain then commit" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "ikey-retain-commit",
    });
    const runId = acquired.run!.runId;
    await runPort.setRunProductTools(runId, [
      { name: "history_retain", description: "t", inputSchema: {}, entrypoint: "sse:x" },
    ]);
    // a message to retain (post-acquire so it is not yet projected)
    const seq = convPort.appendLedgerEntry({
      conversationId,
      senderMemberId: "human-1",
      kind: "message",
      content: JSON.stringify({ role: "user", text: "pin before commit" }),
      ts: Date.now(),
    });
    const callPort = sqliteProductToolCallAdapter(db);
    const toolSvc = createProductToolsService({
      runPort,
      contextPort,
      conversationPort: convPort,
      callPort,
      idGen: { ulid: () => `y-${Math.random().toString(36).slice(2, 8)}` },
    });
    const retained = await toolSvc.call({
      identity: {
        runId,
        conversationId,
        agentMemberId,
        branchId: acquired.run!.branchId,
      },
      callId: "toolu-rc",
      idempotencyKey: `${runId}:toolu-rc`,
      tool: "history_retain",
      args: { seq },
    });
    expect(JSON.parse(retained.content)).toEqual({ retained: true, seq });

    // now the terminal commit must append the final ref ON TOP of the retain
    await runPort.commitCompletedRun({
      runId,
      outcome: { status: "completed", output: { role: "assistant", text: "final" } },
      output: { role: "assistant", text: "final" },
      backendSessionId: "sid-rc",
    });
    const branch = await contextPort.getBranch(acquired.run!.branchId);
    const entries = await contextPort.listEntriesToLeaf(acquired.run!.branchId);
    const refs = entries.filter((e) => e.type === "ledger_message");
    // 1 retain + 1 final commit ref (no other ledger in this harness)
    expect(refs).toHaveLength(2);
    expect(refs[refs.length - 1]!.ledgerSeq).toBeGreaterThan(seq);
    // the chain is intact: walking from the leaf reaches the retain entry
    const leaf = entries[entries.length - 1]!;
    expect(leaf.entryId === branch?.leafEntryId).toBe(true);
    expect(leaf.parentId).toBe(refs[refs.length - 2]!.entryId);
  }, 15_000);

  test("configRevision changes do NOT force rebuild (travel with every input)", () => {
    const branch = { backendKind: "coding_agent", revision: 3 };
    const binding = {
      backendSessionId: "s1",
      backendKind: "coding_agent",
      syncedEntryId: "e1",
      syncedRevision: 2,
      state: "active",
    };
    // model/systemPrompt/productTools/configRevision are per-run snapshot
    // fields, always re-sent - never part of the resume decision.
    expect(decideExecutionPath(binding, branch, { status: "running" } as AgentRun)).toBe("resume");
  });

  test("resume/rebuild decision is a pure function of binding/branch/run", () => {
    const run = {
      status: "running",
    } as AgentRun;
    const branch = { backendKind: "coding_agent", revision: 3 };
    expect(
      decideExecutionPath(
        {
          backendSessionId: "s1",
          backendKind: "coding_agent",
          syncedEntryId: "e1",
          syncedRevision: 2,
          state: "active",
        },
        branch,
        run,
      ),
    ).toBe("resume");
    // missing binding -> rebuild
    expect(decideExecutionPath(null, branch, run)).toBe("rebuild");
    // stale binding -> rebuild
    expect(
      decideExecutionPath(
        {
          backendSessionId: "s1",
          backendKind: "coding_agent",
          syncedEntryId: "e1",
          syncedRevision: 2,
          state: "stale",
        },
        branch,
        run,
      ),
    ).toBe("rebuild");
    // kind mismatch -> rebuild
    expect(
      decideExecutionPath(
        {
          backendSessionId: "s1",
          backendKind: "other",
          syncedEntryId: "e1",
          syncedRevision: 2,
          state: "active",
        },
        branch,
        run,
      ),
    ).toBe("rebuild");
    // revision gap > 1 (context changed) -> rebuild
    expect(
      decideExecutionPath(
        {
          backendSessionId: "s1",
          backendKind: "coding_agent",
          syncedEntryId: "e1",
          syncedRevision: 1,
          state: "active",
        },
        branch,
        run,
      ),
    ).toBe("rebuild");
    // commit_failed -> rebuild
    expect(
      decideExecutionPath(
        {
          backendSessionId: "s1",
          backendKind: "coding_agent",
          syncedEntryId: "e1",
          syncedRevision: 2,
          state: "active",
        },
        branch,
        { status: "commit_failed" } as AgentRun,
      ),
    ).toBe("rebuild");
  });

  test("the run manifest is durable BEFORE the Backend accepts (no auth race)", async () => {
    const fake = createFakeDaemon();
    const execution = makeDeps(fake);
    // The daemon "accepts" the run the moment it sees start - at that point
    // the manifest must already be queryable, because the Worker may call a
    // Product Tool immediately and MCP authorization reads it from the DB.
    fake.setVerifyManifest(async (runId) => {
      const run = await runPort.getRun(runId);
      expect(run?.productTools?.length).toBeGreaterThan(0);
    });
    const acquired = await backend.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "manifest" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "ikey-manifest",
    });
    await execution.dispatch(acquired.run!.runId);
    const run = await waitForTerminal(acquired.run!.runId);
    expect(run?.status).toBe("completed");
    // and the persisted manifest matches the injected entrypoint
    expect(run?.productTools?.[0]?.entrypoint).toBe("sse:http://127.0.0.1:1/mcp");
  }, 15_000);

  test("a completed run on an active binding resumes on the SAME backend session", async () => {
    const fake = createFakeDaemon();
    const execution = makeDeps(fake);

    const first = await backend.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "one" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "ikey-resume-1",
    });
    const runId1 = first.run!.runId;
    await execution.dispatch(runId1);
    await waitForTerminal(runId1);

    // A second run on the same branch: binding is active + synced -> resume.
    const second = await backend.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "two" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 2,
      idempotencyKey: "ikey-resume-2",
    });
    const runId2 = second.run!.runId;
    await execution.dispatch(runId2);
    await waitForTerminal(runId2);

    expect(fake.resumeCalls).toHaveLength(1);
    expect(fake.startCalls).toHaveLength(1); // only the FIRST run started
    expect(fake.resumeCalls[0]!.runId).toBe(runId2);
  }, 15_000);
});
