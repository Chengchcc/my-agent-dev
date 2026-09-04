import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OmaBackend,
  type OmaCommandConfig,
  OmaModelCatalog,
} from "@chengchenccc/adapter-oma-agent";
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

describe("agent run execution recovery", () => {
  test("recovery terminalizes a delivered-active orphan run and promotes the next input", async () => {
    const fake = createFakeDaemon();
    void makeExecution(fake);

    const first = await enqueue("normal", "orphan-1", "first");
    expect(first.acquired).toBe(true);
    const second = await enqueue("normal", "orphan-2", "second");
    expect(second.queued).toBe(true);

    // Simulate "child accepted, then the process died": the input is
    // delivered, the run is still active, and there is no live child.
    await runPort.markInputAccepted(first.inputId);

    // A fresh execution service = a restarted process. recover() must
    // terminalize the orphan and promote the queued input.
    const execution2 = makeExecution(fake);
    await execution2.recover();

    const aborted = await waitForTerminal(first.run!.runId);
    expect(aborted.status).toBe("aborted");
    for (let i = 0; i < 100; i++) {
      const rows = await runPort.listInputs(first.run!.branchId);
      const row = rows.find((r) => r.inputId === second.inputId)!;
      if (row.status === "delivered") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const promoted = (await runPort.listInputs(first.run!.branchId)).find(
      (r) => r.inputId === second.inputId,
    )!;
    expect(promoted.status).toBe("delivered");
    await waitForTerminal(promoted.runId!);
    expect(fake.executeCalls.map((c) => c.runId)).toEqual([promoted.runId!]);
  }, 15_000);

  test("follow-up chain promotes queued inputs as fresh FIFO runs", async () => {
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

  test("acceptance failure terminates the run + cancels the input; recover() never re-executes", async () => {
    const fake = createFakeDaemon({ failFirstExecute: true });
    const execution = makeExecution(fake);

    const acquired = await enqueue("normal", "retry-1", "hello");
    const runId = acquired.run!.runId;

    // First dispatch: the daemon rejects acceptance - a pre-acceptance
    // failure must terminal the run, never leave a running zombie.
    await expect(execution.dispatch(runId)).rejects.toThrow(/simulated execute failure/);
    const run = await waitForTerminal(runId);
    expect(run.status).toBe("failed");
    const inputs = await runPort.listInputs(run.branchId);
    expect(inputs[0]!.status).toBe("cancelled");

    // A fresh execution service (process restart) must NOT re-deliver the
    // cancelled input: a running Run is not a retry queue.
    const execution2 = makeExecution(fake);
    await execution2.recover();
    expect(fake.executeCalls).toHaveLength(1);
  }, 15_000);

  test("pinned workspace reaches the child; recover() is a no-op after terminal failure", async () => {
    const fake = createFakeDaemon({ failFirstExecute: true });
    const execution = makeExecution(fake);

    const pinnedWorkspace = `${dataDir}/pinned-ws`;
    mkdirSync(pinnedWorkspace, { recursive: true });
    const acquired = await backend.enqueueAndAcquire({
      conversationId,
      agentId,
      backendKind: "oma",
      mode: "normal",
      message: { role: "user", text: "hello" },
      defaultModel: { backendKind: "oma", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "ws-1",
      workspace: { root: pinnedWorkspace, access: "read_write" },
    });
    const runId = acquired.run!.runId;
    await expect(execution.dispatch(runId)).rejects.toThrow(/simulated execute failure/);
    // The child records its cwd (canonicalized on macOS): compare realpaths.
    expect(realpathSync(fake.executeCalls[0]!.workspaceRoot)).toBe(realpathSync(pinnedWorkspace));

    // The run is terminal (failed); a restart recovers nothing.
    const run = await waitForTerminal(runId);
    expect(run.status).toBe("failed");
    const execution2 = makeExecution(fake);
    await execution2.recover();
    expect(fake.executeCalls).toHaveLength(1);
  }, 15_000);
});
