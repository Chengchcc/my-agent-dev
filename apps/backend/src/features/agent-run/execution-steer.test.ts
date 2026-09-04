import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
let branchId: string;

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
  const branch = await contextPort.getOrCreateDefaultBranch(tree.treeId, "oma");
  branchId = branch.branchId;
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

describe("agent run execution steer", () => {
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
});
