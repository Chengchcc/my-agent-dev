import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
import { sqliteProjectAdapter } from "../project/adapter-sqlite.js";
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
const agentMemberId = "mem-1";
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
    agentMemberId: string;
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

  convPort.createConversation({ conversationId, createdAt: Date.now() });
  convPort.addMember({
    memberId: agentMemberId,
    conversationId,
    kind: "agent",
    agentId: "a1",
    joinedAt: Date.now(),
  });
  const tree = await contextPort.getOrCreateTree(conversationId, agentMemberId);
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
    agentMemberId,
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

  test("steer is injected into the live run after persistence; accepted only after Backend acceptance", async () => {
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
      agentMemberId,
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
  });

  test("per-run product-tools token: unique across runs, revoked at settle", async () => {
    const fake = createFakeDaemon();
    const registry = createRunTokenRegistry();
    const execution = makeExecution(fake, undefined, undefined, undefined, registry);

    const first = await enqueue("normal", "tok-1", "hello");
    await execution.dispatch(first.run!.runId);
    await waitForTerminal(first.run!.runId);
    const second = await enqueue("normal", "tok-2", "hello again");
    await execution.dispatch(second.run!.runId);
    await waitForTerminal(second.run!.runId);

    const tokens = fake.executeTokens;
    expect(tokens).toHaveLength(2);
    // Different bearers per run...
    expect(new Set(tokens).size).toBe(2);
    // ...and both runs settled, so neither validates anymore.
    for (const t of tokens) expect(registry.validate(t)).toBeNull();
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

  test("project-bound conversation runs with cwd = the worktree", async () => {
    mkdirSync(join(dataDir, "projects", "p-attached"), { recursive: true });
    const projectPort = sqliteProjectAdapter(db);
    for (const pid of ["p-attached", "p-other"]) {
      if (!projectPort.getProject(pid)) {
        projectPort.createProject({
          projectId: pid,
          name: pid,
          repoUrl: null,
          defaultBranch: null,
          createdAt: Date.now(),
        });
      }
    }
    convPort.createConversation({
      conversationId: "conv-proj",
      createdAt: Date.now(),
      projectId: "p-attached",
    });
    convPort.addMember({
      conversationId: "conv-proj",
      memberId: agentMemberId,
      kind: "agent",
      agentId: "agent-1",
      joinedAt: Date.now(),
    });
    const fake = createFakeDaemon();
    const execution = makeExecution(fake);
    const acquired = await backend.enqueueAndAcquire({
      conversationId: "conv-proj",
      agentMemberId,
      backendKind: "oma",
      mode: "normal",
      message: { role: "user", text: "in project" },
      defaultModel: { backendKind: "oma", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "proj-1",
    });
    await execution.dispatch(acquired.run!.runId);
    await waitForTerminal(acquired.run!.runId);
    // D1: the OS may normalize the spawn cwd (macOS /private, symlinks)
    // — compare realpaths, not raw strings.
    expect(realpathSync(fake.executeCalls[0]!.workspaceRoot)).toBe(
      realpathSync(join(dataDir, "projects", "p-attached")),
    );
  }, 15_000);

  test("project-bound conversation with unattached project fails explicitly", async () => {
    const projectPort2 = sqliteProjectAdapter(db);
    if (!projectPort2.getProject("p-other")) {
      projectPort2.createProject({
        projectId: "p-other",
        name: "p-other",
        repoUrl: null,
        defaultBranch: null,
        createdAt: Date.now(),
      });
    }
    convPort.createConversation({
      conversationId: "conv-unattached",
      createdAt: Date.now(),
      projectId: "p-other",
    });
    convPort.addMember({
      conversationId: "conv-unattached",
      memberId: agentMemberId,
      kind: "agent",
      agentId: "agent-1",
      joinedAt: Date.now(),
    });
    const fake = createFakeDaemon();
    const execution = makeExecution(fake);
    const acquired = await backend.enqueueAndAcquire({
      conversationId: "conv-unattached",
      agentMemberId,
      backendKind: "oma",
      mode: "normal",
      message: { role: "user", text: "nope" },
      defaultModel: { backendKind: "oma", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "proj-2",
    });
    await expect(execution.dispatch(acquired.run!.runId)).rejects.toThrow(
      /has not attached project p-other/,
    );
    const run = await waitForTerminal(acquired.run!.runId);
    expect(run.status).toBe("failed");
  }, 15_000);
});
