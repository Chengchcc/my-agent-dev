import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OmaBackend,
  type OmaCommandConfig,
  OmaModelCatalog,
} from "@chengchenccc/adapter-oma-agent";
import { assistantMessageId, parseMessageRevision } from "@chengchenccc/message";
import { openDb } from "../../infra/sqlite/db.js";
import { createAgentContextService, sqliteAgentContextAdapter } from "../agent-context/index.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import {
  createRunTokenRegistry,
  type RunTokenRegistry,
} from "../product-tools/run-token-registry.js";
import { createWorkspaceLockRegistry } from "../project/workspace-lock.js";
import { sqliteAgentRunAdapter } from "./adapter-sqlite.js";
import type { AgentRun } from "./domain.js";
import { createAgentRunExecutionService } from "./execution.js";
import { createAgentRunService } from "./service.js";

// ─── Real RPC child (fixture) harness ─────────────────────────────────
// Every execute() spawns the fixture child (packages/adapter-oma-agent/
// src/__fixtures__/rpc-fixture.ts) speaking the stdio JSONL protocol. The
// fixture records every command to a shared record file; the harness reads
// it back for assertions. This is the REAL child-process transport - no
// in-process fetch, no SSE, no polling.

const FIXTURE = new URL(
  "../../../../../packages/adapter-oma-agent/src/__fixtures__/rpc-fixture.ts",
  import.meta.url,
).pathname;

interface FakeDaemonOptions {
  /** Reject the first execute across all children (acceptance-failure
   *  simulation); later executes accept. */
  failFirstExecute?: boolean;
  outcomeDelayMs?: number;
  /** Fail steer with this message. */
  steerError?: boolean;
  /** Emit native tool trace + todo_update events before the outcome. */
  toolTodo?: boolean;
  /** The completed outcome carries this cliSessionRef. */
  sessionRef?: string;
  /** Raw fixture scenario (overrides the sugar flags). */
  scenario?: string;
}

function createFakeDaemon(opts: FakeDaemonOptions = {}) {
  const record = `${dataDir}/daemon-${daemonSeq++}.log`;
  const scenario =
    opts.scenario ??
    (opts.failFirstExecute
      ? "reject-first-execute"
      : opts.steerError
        ? "steer-error"
        : opts.toolTodo
          ? "tool-todo"
          : "normal");

  const config: OmaCommandConfig = {
    executable: process.execPath,
    args: [FIXTURE, "--mode", "rpc"],
    env: {
      RPC_FIXTURE_SCENARIO: scenario,
      RPC_FIXTURE_RECORD: record,
      RPC_FIXTURE_OUTCOME_DELAY_MS: String(opts.outcomeDelayMs ?? 60),
      ...(opts.sessionRef ? { RPC_FIXTURE_SESSION_REF: opts.sessionRef } : {}),
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
    backend: new OmaBackend(config),
    modelCatalog: new OmaModelCatalog(config),
    get executeCalls(): Array<{ runId: string; workspaceRoot: string }> {
      return readCalls("execute").map((line) => {
        const [runId, ...rest] = line.split(" ");
        return { runId: runId!, workspaceRoot: rest.join(" ") };
      });
    },
    /** Per-run product-tools bearers the children received via env. */
    get executeTokens(): string[] {
      if (!existsSync(record)) return [];
      return readFileSync(record, "utf-8")
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("tok "))
        .map((l) => l.slice(4));
    },
    get executeMessages(): string[] {
      return readCalls("execute_msg").map((l) => JSON.parse(l) as string);
    },
    get executeRefs(): Array<string | null> {
      return readCalls("execute_ref").map((l) => JSON.parse(l) as string | null);
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
const agentId = "ag-1";

function makeExecution(
  fakeDaemon: ReturnType<typeof createFakeDaemon>,
  runPortOverride?: ReturnType<typeof sqliteAgentRunAdapter>,
  modelCatalogOverride?: {
    list: () => Promise<{ models: Array<{ id: string; available: boolean }> }>;
  },
  contextPortOverride?: Partial<typeof contextPort>,
  tokenRegistry?: RunTokenRegistry,
  onRunFailed?: (input: {
    runId: string;
    conversationId: string;
    agentId: string;
    error: string;
  }) => void,
) {
  const activeRunPort = runPortOverride ?? runPort;
  const ledgerResolver = {
    async resolveMessage(cid: string, seq: number) {
      const hit = convPort.getLedgerEntry(cid, seq);
      return hit ? (hit.content as never) : null;
    },
  };
  return createAgentRunExecutionService({
    runPort: activeRunPort,
    contextPort: { ...contextPort, ...contextPortOverride } as never,
    ledgerResolver,
    backends: {
      oma: {
        backend: fakeDaemon.backend,
        catalog: (modelCatalogOverride ?? fakeDaemon.modelCatalog) as never,
      },
    },
    idGen: { ulid: () => `id-${Math.random().toString(36).slice(2, 12)}` },
    resolveWorkspace: async ({ conversationId: cid }) => {
      // Mirrors the composition root: a project-bound conversation maps
      // to the agent's worktree; not attached = explicit failure.
      const convRow = convPort.getConversation(cid);
      if (convRow?.projectId) {
        if (convRow.projectId !== "p-attached") {
          throw new Error(
            `agent has not attached project ${convRow.projectId}; attach it via the agent update API (agent.yml runtime_config.projects)`,
          );
        }
        return { root: join(dataDir, "projects", convRow.projectId), access: "read_write" };
      }
      return { root: dataDir, access: "read_write" };
    },
    productToolsEntrypoint: "sse:http://127.0.0.1:1/mcp",
    workspaceLocks: createWorkspaceLockRegistry(),
    productToolsTokenRegistry: tokenRegistry ?? createRunTokenRegistry(),
    ...(onRunFailed ? { onRunFailed } : {}),
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
      const hit = convPort.getLedgerEntry(cid, seq);
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

  convPort.createConversation({ conversationId, agentId, createdAt: Date.now() });
  const tree = await contextPort.getOrCreateTree(conversationId);
  await contextPort.getOrCreateDefaultBranch(tree.treeId, "oma");
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function enqueue(mode: "normal" | "follow_up" | "steer", key: string, text: string) {
  return backend.enqueueAndAcquire({
    conversationId,
    agentId,
    backendKind: "oma",
    mode,
    message: { role: "user", text },
    defaultModel: { backendKind: "oma", modelId: "fake/echo" },
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
  });

  test("first-turn bridge: no session ref flattens projected history into the input message", async () => {
    const fake = createFakeDaemon();
    const execution = makeExecution(fake);

    // Run 1: fresh branch, empty history -> the message is the raw input.
    const first = await enqueue("normal", "bridge-1", "hello");
    await execution.dispatch(first.run!.runId);
    await waitForTerminal(first.run!.runId);
    expect(fake.executeMessages[0]).toBe("hello");

    // Run 2: the branch now carries run 1's projection; the fixture reports
    // no cliSessionRef, so the bridge flattens history into the message.
    const followUp = await enqueue("follow_up", "bridge-2", "second");
    // The branch is free after run 1 settles: the follow-up acquires a
    // fresh run immediately (no promotion chain needed).
    expect(followUp.acquired).toBe(true);
    await execution.dispatch(followUp.run!.runId);
    await waitForTerminal(followUp.run!.runId);
    // The projected history (run 1's committed assistant message) is flat
    // text ahead of the new input.
    expect(fake.executeMessages[1]).toContain("Assistant: done");
    expect(fake.executeMessages[1]).toContain("second");
    expect(fake.executeMessages[1]!.trimEnd().endsWith("second")).toBe(true);
  }, 15_000);

  test("first-turn bridge keeps tool structure from block messages", async () => {
    const fake = createFakeDaemon({ scenario: "blocks-outcome" });
    const execution = makeExecution(fake);

    const first = await enqueue("normal", "blocks-1", "run checks");
    await execution.dispatch(first.run!.runId);
    await waitForTerminal(first.run!.runId);

    const followUp = await enqueue("follow_up", "blocks-2", "continue");
    await execution.dispatch(followUp.run!.runId);
    await waitForTerminal(followUp.run!.runId);

    const bridged = fake.executeMessages[1] ?? "";
    expect(bridged).toContain("running checks");
    expect(bridged).toContain("[tool bash]");
    expect(bridged).toContain('"cmd":"ls"');
    expect(bridged).toContain("[tool result] file-a");
    expect(bridged.endsWith("continue")).toBe(true);
  }, 15_000);
  test("session ref round-trip: the second run carries the ref, no history bridge", async () => {
    const fake = createFakeDaemon({ sessionRef: "cli-sess-1" });
    const execution = makeExecution(fake);

    // Run 1: the outcome reports cli-sess-1 -> the branch stores
    // `<kind>:cli-sess-1` (settleOutcome prefixes the backend kind).
    const first = await enqueue("normal", "ref-1", "hello");
    await execution.dispatch(first.run!.runId);
    await waitForTerminal(first.run!.runId);
    expect(fake.executeRefs[0]).toBe(null); // fresh branch: no ref yet

    // Run 2 (follow_up): the branch's ref is kind-scoped and STRIPPED for
    // the wire; the message carries NO flat-text history bridge.
    const followUp = await enqueue("follow_up", "ref-2", "second");
    expect(followUp.acquired).toBe(true);
    await execution.dispatch(followUp.run!.runId);
    await waitForTerminal(followUp.run!.runId);
    expect(fake.executeRefs[1]).toBe("cli-sess-1");
    expect(fake.executeMessages[1]).toBe("second");
  }, 15_000);

  test("tool trace and todo_update survive the wire onto the Run SSE", async () => {
    const fake = createFakeDaemon({ toolTodo: true });
    const execution = makeExecution(fake);

    const acquired = await enqueue("normal", "ikey-tools", "use ls");
    const runId = acquired.run!.runId;

    const seen: Array<Record<string, unknown>> = [];
    const sub = execution.subscribe(runId);
    const collector = (async () => {
      for await (const ev of sub) seen.push(ev as Record<string, unknown>);
    })();

    await execution.dispatch(runId);
    await waitForTerminal(runId);
    await collector;

    expect(seen).toContainEqual(
      expect.objectContaining({ type: "native_tool_started", toolName: "ls", callId: "call-1" }),
    );
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: "native_tool_completed",
        toolName: "ls",
        callId: "call-1",
        result: { empty: true },
      }),
    );
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: "backend.oma.todo_update",
        payload: expect.objectContaining({
          items: [
            { id: "t1", text: "step 1", status: "done" },
            { id: "t2", text: "step 2", status: "pending" },
          ],
        }),
      }),
    );
    // The canonical ledger keeps ONLY the final text — no tool/todo entries.
    const ledger = convPort.getLedgerEntries(conversationId);
    const messages = ledger.filter((e) => e.kind === "message");
    expect(messages).toHaveLength(1);
    const revision = parseMessageRevision(messages[0]!.content);
    expect(revision.text).toContain("done");
    expect(JSON.stringify(ledger)).not.toContain("todo_update");
  });

  test("replay of the same dispatch must NOT call the Backend again", async () => {
    const fake = createFakeDaemon();
    const execution = makeExecution(fake);

    const acquired = await enqueue("normal", "ikey-replay", "hello");
    const runId = acquired.run!.runId;
    await execution.dispatch(runId);
    await waitForTerminal(runId);
    expect(fake.executeCalls).toHaveLength(1);
    // replay of the same dispatch is idempotent
    await execution.dispatch(runId);
    expect(fake.executeCalls).toHaveLength(1);
    const ledgerAfter = convPort
      .getLedgerEntries(conversationId)
      .filter((e) => e.kind === "message");
    expect(ledgerAfter).toHaveLength(1);
  }, 15_000);
});
