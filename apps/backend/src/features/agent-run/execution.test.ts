import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodingAgentBackend,
  type CodingAgentCommandConfig,
  CodingAgentModelCatalog,
} from "@my-agent-team/adapter-coding-agent";
import { assistantMessageId, parseMessageRevision } from "@my-agent-team/message";
import { openDb } from "../../infra/sqlite/db.js";
import { createAgentContextService, sqliteAgentContextAdapter } from "../agent-context/index.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import { sqliteAgentRunAdapter } from "./adapter-sqlite.js";
import type { AgentRun } from "./domain.js";
import { createAgentRunExecutionService } from "./execution.js";
import { createAgentRunService } from "./service.js";

// ─── Real RPC child (fixture) harness ─────────────────────────────────
// Every execute() spawns the fixture child (packages/adapter-coding-agent/
// src/__fixtures__/rpc-fixture.ts) speaking the stdio JSONL protocol. The
// fixture records every command to a shared record file; the harness reads
// it back for assertions. This is the REAL child-process transport - no
// in-process fetch, no SSE, no polling.

const FIXTURE = new URL(
  "../../../../../packages/adapter-coding-agent/src/__fixtures__/rpc-fixture.ts",
  import.meta.url,
).pathname;

interface FakeDaemonOptions {
  /** Reject the first execute across all children (acceptance-failure
   *  simulation); later executes accept. */
  failFirstExecute?: boolean;
  outcomeDelayMs?: number;
  /** Fail steer with this message. */
  steerError?: boolean;
}

function createFakeDaemon(opts: FakeDaemonOptions = {}) {
  const record = `${dataDir}/daemon-${daemonSeq++}.log`;
  const scenario = opts.failFirstExecute
    ? "reject-first-execute"
    : opts.steerError
      ? "steer-error"
      : "normal";
  const config: CodingAgentCommandConfig = {
    executable: process.execPath,
    args: [FIXTURE, "--mode", "rpc"],
    env: {
      RPC_FIXTURE_SCENARIO: scenario,
      RPC_FIXTURE_RECORD: record,
      RPC_FIXTURE_OUTCOME_DELAY_MS: String(opts.outcomeDelayMs ?? 60),
    },
  };
  const readCalls = (kind: string): string[] => {
    if (!existsSync(record)) return [];
    return readFileSync(record, "utf-8")
      .trim()
      .split("\n")
      .filter((l) => l.startsWith(`${kind} `))
      .map((l) => l.slice(kind.length + 1));
  };
  return {
    backend: new CodingAgentBackend(config),
    modelCatalog: new CodingAgentModelCatalog(config),
    get executeCalls(): Array<{ runId: string; workspaceRoot: string }> {
      return readCalls("execute").map((line) => {
        const [runId, ...rest] = line.split(" ");
        return { runId: runId!, workspaceRoot: rest.join(" ") };
      });
    },
    get steerCalls(): string[] {
      return readCalls("steer").map((l) => l.split(" ")[0]!);
    },
    get stopCalls(): string[] {
      return readCalls("abort").map((l) => l.split(" ")[0]!);
    },
  };
}

let daemonSeq = 0;

// ─── Test harness ──────────────────────────────────────────────────────

let dataDir: string;
let db: ReturnType<typeof openDb>;
let convPort: ReturnType<typeof sqliteConversationAdapter>;
let contextPort: ReturnType<typeof sqliteAgentContextAdapter>;
let backend: ReturnType<typeof createAgentRunService>;
let runPort: ReturnType<typeof sqliteAgentRunAdapter>;

const conversationId = "conv-1";
const agentMemberId = "mem-1";
let branchId: string;

function makeExecution(
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
  return createAgentRunExecutionService({
    runPort: activeRunPort,
    contextPort,
    ledgerResolver,
    backend: fakeDaemon.backend,
    modelCatalog: fakeDaemon.modelCatalog,
    idGen: { ulid: () => `id-${Math.random().toString(36).slice(2, 12)}` },
    resolveWorkspace: async () => ({ root: dataDir, access: "read_write" }),
    productToolsEntrypoint: "sse:http://127.0.0.1:1/mcp",
  });
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
  dataDir = mkdtempSync(join(tmpdir(), "phase5-exec-"));
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
  const tree = await contextPort.getOrCreateTree(conversationId, agentMemberId);
  const branch = await contextPort.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
  branchId = branch.branchId;
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function enqueue(mode: "normal" | "follow_up" | "steer", key: string, text: string) {
  return backend.enqueueAndAcquire({
    conversationId,
    agentMemberId,
    backendKind: "coding_agent",
    mode,
    message: { role: "user", text },
    defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
    configRevision: 1,
    idempotencyKey: key,
  });
}

describe("agent run execution (Run-centric)", () => {
  test("a normal input creates one Run; terminal commit writes a parseable final Message", async () => {
    const fake = createFakeDaemon();
    const execution = makeExecution(fake);

    const acquired = await enqueue("normal", "ikey-1", "hello");
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

    // one input, one backend execute, one delivered input
    expect(fake.executeCalls).toHaveLength(1);
    expect(fake.executeCalls[0]!.runId).toBe(runId);
    const inputs = await runPort.listInputs(run.branchId);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.status).toBe("delivered");

    // exactly one assistant message in the ledger - a VALID MessageRevision
    const ledger = convPort.getLedgerEntries(conversationId);
    const messages = ledger.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(1);
    const revision = parseMessageRevision(messages[0]!.content);
    expect(revision).toMatchObject({
      messageId: assistantMessageId(runId, 0),
      role: "assistant",
      state: "done",
      conversationId,
    });
    expect(revision.updatedAt).toBeGreaterThan(0);

    // exactly one ledger_message ref in context
    const entries = await contextPort.listEntriesToLeaf(run.branchId);
    const refs = entries.filter((e) => e.type === "ledger_message");
    expect(refs).toHaveLength(1);

    // subscriber saw the transient events
    expect(events).toContain("text_delta");
    expect(events).toContain("status");

    // replay of the same dispatch must NOT call the Backend again
    await execution.dispatch(runId);
    expect(fake.executeCalls).toHaveLength(1);
    const ledgerAfter = convPort
      .getLedgerEntries(conversationId)
      .filter((e) => e.kind === "message");
    expect(ledgerAfter).toHaveLength(1);
  }, 15_000);

  test("branch busy: a second normal/follow_up input creates a QUEUED run; the oldest promotes after the first settles", async () => {
    const fake = createFakeDaemon({ outcomeDelayMs: 120 });
    const execution = makeExecution(fake);

    const first = await enqueue("normal", "chain-1", "first");
    expect(first.acquired).toBe(true);
    const followUp = await enqueue("follow_up", "chain-2", "second");
    expect(followUp.queued).toBe(true);
    const third = await enqueue("normal", "chain-3", "third");
    expect(third.queued).toBe(true);

    await execution.dispatch(first.run!.runId);
    await waitForTerminal(first.run!.runId);

    // Both queued inputs became FRESH runs, executed in FIFO order. The
    // chain promotes one run per settle - wait for the full chain.
    for (let i = 0; i < 200 && fake.executeCalls.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const inputs = await runPort.listInputs(first.run!.branchId);
    const queued = inputs.filter((i) => i.runId && i.runId !== first.run!.runId);
    expect(queued).toHaveLength(2);
    const [secondRunId, thirdRunId] = [queued[0]!.runId!, queued[1]!.runId!];
    const second = await waitForTerminal(secondRunId);
    expect(second.status).toBe("completed");
    const thirdRun = await waitForTerminal(thirdRunId);
    expect(thirdRun.status).toBe("completed");
    expect(fake.executeCalls.map((c) => c.runId)).toEqual([
      first.run!.runId,
      secondRunId,
      thirdRunId,
    ]);
  }, 20_000);

  test("a Run never calls Backend execute twice (acceptance failure keeps input delivering; retry re-executes once)", async () => {
    const fake = createFakeDaemon({ failFirstExecute: true });
    const execution = makeExecution(fake);

    const acquired = await enqueue("normal", "retry-1", "hello");
    const runId = acquired.run!.runId;

    // First dispatch: the daemon rejects acceptance - the input stays
    // delivering, the run stays running. The acceptance error is surfaced.
    await expect(execution.dispatch(runId)).rejects.toThrow(/simulated execute failure/);
    const run = await runPort.getRun(runId);
    expect(run?.status).toBe("running");
    const inputs = await runPort.listInputs(run!.branchId);
    expect(inputs[0]!.status).toBe("delivering");

    // A fresh execution service (process restart) recovers the same input
    // with the same runId: the daemon dedupes by runId + payload.
    const execution2 = makeExecution(fake);
    await execution2.recover();
    const settled = await waitForTerminal(runId);
    expect(settled.status).toBe("completed");
    expect(fake.executeCalls.map((c) => c.runId)).toEqual([runId, runId]);
    // Same runId delivered twice to the daemon (retry), but the run only
    // ever produced ONE ledger message.
    const ledger = convPort.getLedgerEntries(conversationId).filter((e) => e.kind === "message");
    expect(ledger).toHaveLength(1);
  }, 15_000);

  test("recovery uses the workspace snapshot persisted on the Run", async () => {
    const fake = createFakeDaemon({ failFirstExecute: true });
    const execution = makeExecution(fake);

    const pinnedWorkspace = `${dataDir}/pinned-ws`;
    mkdirSync(pinnedWorkspace, { recursive: true });
    const acquired = await backend.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "hello" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "ws-1",
      workspace: { root: pinnedWorkspace, access: "read_write" },
    });
    const runId = acquired.run!.runId;
    await expect(execution.dispatch(runId)).rejects.toThrow(/simulated execute failure/);
    // The child records its cwd (canonicalized on macOS): compare realpaths.
    expect(realpathSync(fake.executeCalls[0]!.workspaceRoot)).toBe(realpathSync(pinnedWorkspace));

    // Restart: a NEW execution service recovers - it must NOT re-resolve the
    // workspace from the conversation; it re-uses the persisted snapshot.
    const execution2 = makeExecution(fake);
    await execution2.recover();
    await waitForTerminal(runId);
    expect(realpathSync(fake.executeCalls[1]!.workspaceRoot)).toBe(realpathSync(pinnedWorkspace));
  }, 15_000);

  test("steer is injected into the live run after persistence; accepted only after Backend acceptance", async () => {
    const fake = createFakeDaemon({ outcomeDelayMs: 1500 });
    const execution = makeExecution(fake);

    const first = await enqueue("normal", "steer-1", "first");
    // Fire dispatch WITHOUT awaiting: the steer must land while the run is
    // live (dispatch resolves only after the run settles).
    const dispatchP = execution.dispatch(first.run!.runId);
    // Wait until the daemon accepted the run (input delivered).
    for (let i = 0; i < 100; i++) {
      const inputs = await runPort.listInputs(first.run!.branchId);
      if (inputs[0]?.status === "delivered") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // The steer input persists FIRST, then injectSteer delivers it live.
    const steer = await enqueue("steer", "steer-2", "steer me");
    expect(steer.queued).toBe(true);
    const steerInputId = steer.inputId;
    const inputsAfter = await runPort.listInputs(first.run!.branchId);
    const steerRow = inputsAfter.find((i) => i.inputId === steerInputId)!;
    expect(steerRow.status).toBe("pending"); // not delivered yet

    await execution.injectSteer(first.run!.branchId, {
      inputId: steerInputId,
      message: { role: "user", text: "steer me" },
    });
    expect(fake.steerCalls).toEqual([first.run!.runId]);
    const after = await runPort.listInputs(first.run!.branchId);
    expect(after.find((i) => i.inputId === steerInputId)!.status).toBe("delivered");

    await dispatchP;
    await waitForTerminal(first.run!.runId);
  }, 15_000);

  test("steer is cancelled (never delivered) when Backend acceptance fails", async () => {
    const fake = createFakeDaemon({
      outcomeDelayMs: 1500,
      steerError: true,
    });
    const execution = makeExecution(fake);

    const first = await enqueue("normal", "steer-3", "first");
    const dispatchP = execution.dispatch(first.run!.runId);
    for (let i = 0; i < 100; i++) {
      const inputs = await runPort.listInputs(first.run!.branchId);
      if (inputs[0]?.status === "delivered") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const steer = await enqueue("steer", "steer-4", "steer me");
    const steerInputId = steer.inputId;
    await expect(
      execution.injectSteer(first.run!.branchId, {
        inputId: steerInputId,
        message: { role: "user", text: "steer me" },
      }),
    ).rejects.toThrow(/live run/);
    const after = await runPort.listInputs(first.run!.branchId);
    expect(after.find((i) => i.inputId === steerInputId)!.status).toBe("cancelled");
    await dispatchP;
    await waitForTerminal(first.run!.runId);
  }, 15_000);

  test("steer with no active run is cancelled at enqueue and never creates a Run", async () => {
    const fake = createFakeDaemon();
    const execution = makeExecution(fake);

    const steer = await enqueue("steer", "steer-5", "steer me");
    expect(steer.acquired).toBe(false);
    expect(steer.cancelled).toBe(true);
    // No run was created on the branch at all.
    expect(await runPort.getActiveRun(branchId)).toBeNull();
    const inputs = await runPort.listInputs(branchId);
    const steerRow = inputs.find((i) => i.inputId === steer.inputId);
    expect(steerRow?.status).toBe("cancelled");
    expect(fake.executeCalls).toHaveLength(0);
    void execution;
  }, 15_000);

  test("retryTerminalCommit replays the STORED outcome without re-executing the Backend", async () => {
    // Fault-inject the commit once so the run lands in commit_failed.
    let failCommit = true;
    const fake = createFakeDaemon();
    const ledgerResolver = {
      async resolveMessage(cid: string, seq: number) {
        const entries = convPort.getLedgerEntries(cid);
        const hit = entries.find((e) => e.seq === seq);
        return hit ? (hit.content as never) : null;
      },
    };
    const failingRunPort = sqliteAgentRunAdapter(db, {
      contextPort,
      ledgerResolver,
      idGen: { ulid: () => `f-${Math.random().toString(36).slice(2, 10)}` },
      commitTestHook: () => {
        if (failCommit) throw new Error("simulated product commit failure");
      },
    });
    const execution = makeExecution(fake, failingRunPort);

    const acquired = await enqueue("normal", "commit-1", "hello");
    const runId = acquired.run!.runId;
    await execution.dispatch(runId);
    const failed = await waitForTerminal(runId);
    expect(failed.status).toBe("commit_failed");
    expect(fake.executeCalls).toHaveLength(1);
    // Branch stays occupied: a queued input must NOT be promoted.
    const queued = await enqueue("normal", "commit-2", "second");
    expect(queued.queued).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.executeCalls).toHaveLength(1);

    // Retry the terminal commit: no Backend call, one ledger message.
    failCommit = false;
    await execution.retryTerminalCommit(runId);
    const run = await runPort.getRun(runId);
    expect(run?.status).toBe("completed");
    expect(fake.executeCalls).toHaveLength(1);
    const ledger = convPort.getLedgerEntries(conversationId).filter((e) => e.kind === "message");
    expect(ledger).toHaveLength(1);
    const revision = parseMessageRevision(ledger[0]!.content);
    expect(revision.messageId).toBe(assistantMessageId(runId, 0));
  }, 15_000);

  test("stop() requests cancellation on the live segment", async () => {
    const fake = createFakeDaemon({ outcomeDelayMs: 2000 });
    const execution = makeExecution(fake);
    const acquired = await enqueue("normal", "stop-1", "hello");
    const runId = acquired.run!.runId;
    const dispatchPromise = execution.dispatch(runId);
    // Wait until the run is delivered (Backend acceptance complete): the
    // live handle exists and stop() targets the child.
    for (let i = 0; i < 100; i++) {
      const inputs = await runPort.listInputs(acquired.run!.branchId);
      if (inputs[0]?.status === "delivered") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await execution.stop(runId);
    await dispatchPromise;
    expect(fake.stopCalls).toEqual([runId]);
    await waitForTerminal(runId);
  }, 15_000);
});
