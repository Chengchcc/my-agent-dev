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
  const fetchImpl: typeof fetch = async (url, init) => {
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
    fetchImpl,
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

function makeDeps(fakeDaemon: ReturnType<typeof createFakeDaemon>) {
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
    runPort,
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
