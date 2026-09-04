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
import { createAgentRunExecutionService, runEventStreamFor } from "./execution.js";
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

describe("agent run execution failure & subscription", () => {
  test("preflight failure closes subscribers (no SSE hang)", async () => {
    const fake = createFakeDaemon();
    const execution = makeExecution(fake, undefined, {
      list: async () => {
        throw new Error("catalog down");
      },
    });

    const acquired = await enqueue("normal", "close-1", "hello");
    const runId = acquired.run!.runId;

    const collector = (async () => {
      const events: Array<{ type: string; status?: string; error?: string }> = [];
      for await (const ev of execution.subscribe(runId)) {
        if (ev.type === "status") events.push(ev);
      }
      return events;
    })();

    await expect(execution.dispatch(runId)).rejects.toThrow("catalog down");

    // The subscriber stream must END after the failed dispatch, not hang
    // until the HTTP layer's headers timeout — and the sole event carries
    // the failure so the UI can show WHY the run died.
    await expect(
      Promise.race([
        collector,
        Bun.sleep(500).then(() => {
          throw new Error("subscriber did not close");
        }),
      ]),
    ).resolves.toEqual([{ type: "status", status: "failed", error: "catalog down" }]);
  }, 15_000);

  test("failed dispatch fires onRunFailed with the error (T3-2)", async () => {
    const fake = createFakeDaemon();
    const failures: Array<{ runId: string; error: string }> = [];
    const execution = makeExecution(
      fake,
      undefined,
      {
        list: async () => {
          throw new Error("catalog down");
        },
      },
      undefined,
      undefined,
      (input) => {
        failures.push({ runId: input.runId, error: input.error });
      },
    );

    const acquired = await enqueue("normal", "fail-hook", "hello");
    const runId = acquired.run!.runId;
    await expect(execution.dispatch(runId)).rejects.toThrow("catalog down");
    // The surface hook receives the failure so it can persist an assistant
    // error message (T3-2) — the failure survives refresh.
    expect(failures).toEqual([{ runId, error: "catalog down" }]);
  }, 15_000);

  test("spawn failure is permanent: run finalized failed, delivering input cancelled, subscribers closed", async () => {
    const fake = createFakeDaemon();
    const execution = makeExecution({
      backend: new OmaBackend({
        executable: "/nonexistent/definitely-missing-bin",
        env: {},
      }),
      modelCatalog: fake.modelCatalog,
    } as ReturnType<typeof createFakeDaemon>);

    const acquired = await enqueue("normal", "perm-1", "hello");
    const runId = acquired.run!.runId;

    const collector = (async () => {
      const events: Array<{ type: string; status?: string; error?: string }> = [];
      for await (const ev of execution.subscribe(runId)) {
        if (ev.type === "status") events.push(ev);
      }
      return events;
    })();

    await expect(execution.dispatch(runId)).rejects.toThrow();

    const run = await waitForTerminal(runId);
    expect(run.status).toBe("failed");
    if (run.terminalResult?.status === "failed") {
      expect(run.terminalResult.error).toContain("ENOENT");
    }

    const inputs = await runPort.listInputs(run.branchId);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.status).toBe("cancelled");

    // The failed status event (with the error text) is the only live
    // failure record subscribers get before the stream closes.
    const events = await Promise.race([
      collector,
      Bun.sleep(500).then(() => {
        throw new Error("subscriber did not close");
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "status", status: "failed" });
    expect(events[0]!.error).toContain("ENOENT");
  }, 15_000);

  test("execute rejection is a pre-acceptance failure: run failed + input cancelled", async () => {
    const fake = createFakeDaemon({ failFirstExecute: true });
    const execution = makeExecution(fake);

    const acquired = await enqueue("normal", "perm-2", "hello");
    const runId = acquired.run!.runId;

    await expect(execution.dispatch(runId)).rejects.toThrow(/rejected execute/);

    const run = await waitForTerminal(runId);
    expect(run.status).toBe("failed");
    const inputs = await runPort.listInputs(run.branchId);
    expect(inputs[0]!.status).toBe("cancelled");
  }, 15_000);

  test("Context projection failure: run failed, input cancelled, subscriber closed", async () => {
    const fake = createFakeDaemon();
    const execution = makeExecution(fake, undefined, undefined, {
      listEntriesToLeaf: async () => {
        throw new Error("projection boom");
      },
    });

    const acquired = await enqueue("normal", "proj-1", "hello");
    const runId = acquired.run!.runId;

    const collector = (async () => {
      const events: Array<{ type: string; status?: string; error?: string }> = [];
      for await (const ev of execution.subscribe(runId)) {
        if (ev.type === "status") events.push(ev);
      }
      return events;
    })();

    await expect(execution.dispatch(runId)).rejects.toThrow("projection boom");

    const run = await waitForTerminal(runId);
    expect(run.status).toBe("failed");
    const inputs = await runPort.listInputs(run.branchId);
    expect(inputs[0]!.status).toBe("cancelled");

    await expect(
      Promise.race([
        collector,
        Bun.sleep(500).then(() => {
          throw new Error("subscriber did not close");
        }),
      ]),
    ).resolves.toEqual([{ type: "status", status: "failed", error: "projection boom" }]);
  }, 15_000);

  test("no-live cancel releases the branch and promotes the next queued input", async () => {
    const fake = createFakeDaemon();
    const execution = makeExecution(fake);

    const first = await enqueue("normal", "cancel-1", "first");
    expect(first.acquired).toBe(true);
    const second = await enqueue("normal", "cancel-2", "second");
    expect(second.queued).toBe(true);

    // Simulate a zombie: the first run is active in the DB but was never
    // dispatched on this process (no live child). stop() must terminal it,
    // cancel its input, and promote the queued input into a FRESH run.
    await execution.stop(first.run!.runId);

    const aborted = await waitForTerminal(first.run!.runId);
    expect(aborted.status).toBe("aborted");
    const inputs = await runPort.listInputs(first.run!.branchId);
    const firstInput = inputs.find((i) => i.inputId === first.inputId)!;
    expect(firstInput.status).toBe("cancelled");

    // The queued input became a new run that actually executed. The chain
    // dispatch is fire-and-forget: poll until the child accepted it.
    const secondInput = inputs.find((i) => i.inputId === second.inputId)!;
    expect(secondInput.runId).not.toBe(first.run!.runId);
    for (let i = 0; i < 100; i++) {
      const rows = await runPort.listInputs(first.run!.branchId);
      const row = rows.find((r) => r.inputId === second.inputId)!;
      if (row.status === "delivered") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const delivered = (await runPort.listInputs(first.run!.branchId)).find(
      (r) => r.inputId === second.inputId,
    )!;
    expect(delivered.status).toBe("delivered");
    await waitForTerminal(delivered.runId!);
    expect(fake.executeCalls.map((c) => c.runId)).toEqual([delivered.runId!]);
  }, 15_000);

  test("late subscription to a settled run closes immediately with a terminal status", async () => {
    const fake = createFakeDaemon();
    const execution = makeExecution(fake);
    const acquired = await enqueue("normal", "late-1", "hello");
    const runId = acquired.run!.runId;
    await execution.dispatch(runId);
    await waitForTerminal(runId);

    // The run settled BEFORE the UI connected: the stream must yield one
    // terminal status and end, not hang until an HTTP timeout.
    const events: string[] = [];
    for await (const ev of runEventStreamFor({ status: "completed" }, execution, runId)) {
      events.push(ev.type);
    }
    expect(events).toEqual(["status"]);
  }, 15_000);

  test("late subscription to a zombie run terminalizes it and reports aborted", async () => {
    const fake = createFakeDaemon();
    const execution = makeExecution(fake);
    const acquired = await enqueue("normal", "late-2", "hello");
    const runId = acquired.run!.runId;
    // Never dispatched: active in DB, no live child, not in flight.
    const events: string[] = [];
    for await (const ev of runEventStreamFor({ status: "running" }, execution, runId)) {
      events.push(ev.type);
    }
    expect(events).toEqual(["status"]);
    const run = await waitForTerminal(runId);
    expect(run.status).toBe("aborted");
    const inputs = await runPort.listInputs(run.branchId);
    expect(inputs[0]!.status).toBe("cancelled");
  }, 15_000);

  test("SSE subscription during pre-acceptance dispatch does NOT abort the run", async () => {
    // The exact user-visible race: Web connects to /agent-runs/:id/events
    // right after POST, while the child has NOT accepted yet (isLive=false,
    // isInflight=true). The stream must subscribe, never abortStaleRun.
    const fake = createFakeDaemon({ outcomeDelayMs: 80 });
    const execution = makeExecution(fake);

    const acquired = await enqueue("normal", "inflight-1", "hello");
    const runId = acquired.run!.runId;

    // Fire dispatch; subscribe BEFORE the (slow) acceptance lands.
    const dispatchP = execution.dispatch(runId);
    const events: string[] = [];
    const collectP = (async () => {
      for await (const ev of runEventStreamFor({ status: "running" }, execution, runId)) {
        events.push(ev.type);
      }
    })();
    await dispatchP;
    await collectP;

    // The run was NOT aborted: it completed and its input was delivered.
    const run = await waitForTerminal(runId);
    expect(run.status).toBe("completed");
    const inputs = await runPort.listInputs(run.branchId);
    expect(inputs[0]!.status).toBe("delivered");
  }, 15_000);

  test("runEventStreamFor subscribes for inflight runs without aborting", async () => {
    const aborted: string[] = [];
    const events: string[] = [];
    const stream = runEventStreamFor(
      { status: "running" },
      {
        isLive: () => false,
        isInflight: () => true,
        abortStaleRun: async (id) => {
          aborted.push(id);
        },
        subscribe: () =>
          (async function* () {
            yield { type: "status", status: "running" };
          })(),
      },
      "r-inflight",
    );
    for await (const ev of stream) events.push(ev.type);
    expect(events).toEqual(["status"]);
    expect(aborted).toEqual([]);
  });

  test("commit_failed run: SSE reports failed WITHOUT aborting the Product run", async () => {
    const aborted: string[] = [];
    const events: string[] = [];
    const stream = runEventStreamFor(
      { status: "commit_failed" },
      {
        isLive: () => false,
        isInflight: () => false,
        abortStaleRun: async (id) => {
          aborted.push(id);
        },
        subscribe: () => (async function* () {})(),
      },
      "r-cf",
    );
    for await (const ev of stream) events.push(ev.type);
    // The stored outcome is the terminal authority; retryTerminalCommit owns
    // recovery. The SSE must NOT touch the run.
    expect(events).toEqual(["status"]);
    expect(aborted).toEqual([]);
  });
});
