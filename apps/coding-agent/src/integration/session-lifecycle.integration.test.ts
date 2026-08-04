import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CodingAgentBackend, CodingAgentClient } from "@my-agent-team/adapter-coding-agent";
import type { CodingSessionEntry, SessionStore } from "@my-agent-team/agent";
import { createSqliteSessionStore } from "@my-agent-team/agent";
import { createModelRuntime } from "@my-agent-team/ai";
import { createCodingAgentApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createCodingSessionSupervisor } from "../session-supervisor.js";

/** Session lifecycle through the REAL Worker: start -> follow-up -> steer ->
 *  close. Each run returns a canonical outcome; usage is accumulated across
 *  model calls; close deletes the session file. */

const tmp = `/tmp/coding-lifecycle-${Math.random().toString(36).slice(2, 8)}`;
const ws = `${tmp}/ws`;
let app: ReturnType<typeof createCodingAgentApp>;
let baseUrl: string;
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  mkdirSync(ws, { recursive: true });
  const config = loadConfig({
    CODING_AGENT_AUTH_TOKEN: "token-123",
    CODING_AGENT_DATA_DIR: tmp,
    CODING_AGENT_WORKSPACE_ROOTS: ws,
    CODING_AGENT_FAKE_PROVIDER: "1",
  });
  const supervisor = createCodingSessionSupervisor({
    workerEntry: join(import.meta.dir, "..", "worker-main.ts"),
    cwd: tmp,
    sessionsDir: `${tmp}/sessions`,
    authEnv: { ...config.providerEnv, CODING_AGENT_FAKE_PROVIDER: "1" },
    eventBufferSize: 100,
    workerStopGraceMs: 500,
    acceptTimeoutMs: 10_000,
    workspaceRoots: config.workspaceRoots,
    maxStartingWorkers: 4,
  });
  app = createCodingAgentApp({ config, modelRuntime: createModelRuntime(), supervisor });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: app.fetch });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server?.stop();
  await app.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe("session lifecycle (real worker)", () => {
  test("start -> follow-up -> close; canonical output + usage accumulate", async () => {
    const client = new CodingAgentClient({ baseUrl, authToken: "token-123" });
    const backend = new CodingAgentBackend(client);
    const first = await backend.start({
      history: [],
      input: { inputId: "in-1", message: { role: "user", text: "first" } },
      run: {
        runId: "run-life-1",
        model: { backendKind: "coding_agent", modelId: "fake/echo" },
        productTools: [],
        configRevision: 1,
      },
      workspace: { root: ws, access: "read_write" },
      metadata: { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 1 },
    });
    const session = first.session;
    // Let the first run settle (the daemon rejects a follow-up while active).
    const outcome1 = await first.segment.outcome;
    expect(outcome1.status).toBe("completed");

    // Follow-up on the SAME session (new run, same worker), carrying a
    // Product Tool manifest so the real worker's per-run resolveTools path
    // is exercised end-to-end.
    const followUp = await backend.send(session, {
      history: [],
      input: { inputId: "in-2", message: { role: "user", text: "second" } },
      run: {
        runId: "run-life-2",
        model: { backendKind: "coding_agent", modelId: "fake/echo" },
        productTools: [
          {
            name: "echo_tool",
            description: "Echo",
            inputSchema: { type: "object" },
            entrypoint: "stdio:not-reached",
          },
        ],
        configRevision: 2,
      },
      mode: "follow_up",
      metadata: { branchId: "b", productRevision: 2 },
    });
    const outcome2 = await followUp.outcome;
    expect(outcome2.status).toBe("completed");
    if (outcome2.status === "completed") {
      // Canonical output from the persisted assistant Message.
      expect(outcome2.output).toBeDefined();
      // Usage accumulated from the model chunks (fake provider emits usage).
      expect(outcome2.usage?.inputTokens).toBeGreaterThan(0);
    }

    // Close deletes the session file (deleteData defaults true).
    await backend.close(session);
    const { existsSync } = await import("node:fs");
    const { globSync } = await import("node:fs");
    const leftovers = globSync(`${tmp}/sessions/*.sqlite*`);
    expect(leftovers).toHaveLength(0);
    void existsSync;
  }, 30_000);

  test("cross-Worker persistence: Run 2 on a new PID restores todo, branch, productEntryId, replay, compact", async () => {
    // Two Runs on the SAME session, each in its OWN one-shot Worker: the
    // second Worker must read the state the first persisted. The fake
    // provider is scripted to call todo_write on the first run.
    const persistTmp = `/tmp/coding-persist-${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(`${persistTmp}/ws`, { recursive: true });
    const persistConfig = loadConfig({
      CODING_AGENT_AUTH_TOKEN: "token-123",
      CODING_AGENT_DATA_DIR: persistTmp,
      CODING_AGENT_WORKSPACE_ROOTS: `${persistTmp}/ws`,
      CODING_AGENT_FAKE_PROVIDER: "1",
    });
    const persistRuntime = createModelRuntime();
    const persistSup = createCodingSessionSupervisor({
      workerEntry: join(import.meta.dir, "..", "worker-main.ts"),
      cwd: persistTmp,
      sessionsDir: `${persistTmp}/sessions`,
      authEnv: {
        ...persistConfig.providerEnv,
        CODING_AGENT_FAKE_PROVIDER: "1",
        CODING_AGENT_FAKE_TOOL: JSON.stringify([
          {
            name: "todo_write",
            input: { items: [{ id: "t1", text: "task one", status: "pending" }] },
          },
        ]),
      },
      eventBufferSize: 100,
      workerStopGraceMs: 500,
      acceptTimeoutMs: 10_000,
      workspaceRoots: persistConfig.workspaceRoots,
      maxStartingWorkers: 4,
      modelRuntime: persistRuntime,
    });
    const persistApp = createCodingAgentApp({
      config: persistConfig,
      modelRuntime: persistRuntime,
      supervisor: persistSup,
    });
    const persistServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: persistApp.fetch,
    });
    const persistClient = new CodingAgentClient({
      baseUrl: `http://127.0.0.1:${persistServer.port}`,
      authToken: "token-123",
    });
    const persistBackend = new CodingAgentBackend(persistClient);
    // The session id is derived from the idempotency key (inputId); the
    // sqlite file lives under that name.
    let sessionFile = "";
    try {
      const started = await persistBackend.start({
        history: [],
        input: {
          inputId: "in-p1",
          // Large enough that the branch exceeds the fake model's context
          // budget (200k) and a manual compact actually cuts + persists a
          // compaction entry.
          message: { role: "user", text: `first ${"y".repeat(900_000)}` },
          productEntryId: "pe-1",
        },
        run: {
          runId: "run-p-1",
          model: { backendKind: "coding_agent", modelId: "fake/echo" },
          productTools: [],
          systemPrompt: "SYS-PROMPT-MARKER",
          configRevision: 1,
        },
        workspace: { root: `${persistTmp}/ws`, access: "read_write" },
        metadata: { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 1 },
      });
      // Read through the Phase 2 SessionStore PUBLIC API (never the SQLite
      // table layout): open/readBranch/findByProductEntryIds are the
      // persistence contract.
      const sid = started.session.backendSessionId;
      const withStore = async <T>(fn: (store: SessionStore) => Promise<T>): Promise<T> => {
        const store = createSqliteSessionStore(sessionFile);
        try {
          await store.open(sid);
          return await fn(store);
        } finally {
          await store.close();
        }
      };
      const readBranch = () => withStore((store) => store.readBranch(sid));
      const countProductEntry = (id: string) =>
        withStore((store) => store.findByProductEntryIds(sid, [id]).then((r) => r.length));
      // Capture Run 1's worker PID at acceptance (the one-shot worker exits
      // right after its outcome, so it must be read before the outcome).
      const pid1 = persistSup
        .listSessions()
        .find((v) => v.backendSessionId === started.session.backendSessionId)?.workerPid;
      expect(pid1).not.toBeNull();
      const outcome1 = await started.segment.outcome;
      expect(outcome1.status).toBe("completed");
      sessionFile = `${persistTmp}/sessions/${started.session.backendSessionId}.sqlite`;

      // Run 1's one-shot worker exits after its outcome; the session
      // returns to idle with no live worker.
      for (let i = 0; i < 100; i++) {
        const view = persistSup
          .listSessions()
          .find((v) => v.backendSessionId === started.session.backendSessionId);
        if (view?.state === "idle" && view.workerPid === null) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const idleView = persistSup
        .listSessions()
        .find((v) => v.backendSessionId === started.session.backendSessionId);
      expect(idleView?.state).toBe("idle");
      expect(idleView?.workerPid).toBeNull();

      // Persistence across the Worker boundary: completed branch leaf,
      // productEntryId lossless, todo state present, system prompt NOT in
      // the tree.
      const branch1 = await readBranch();
      const snapshot = await withStore((store) => store.open(sid));
      expect(snapshot.metadata.leafEntryId).toBeTruthy();
      expect(await countProductEntry("pe-1")).toBe(1);
      const todos = branch1.filter((e) => e.type === "todo") as Array<{
        state: Record<string, unknown>;
      }>;
      expect(todos).toHaveLength(1);
      expect(todos[0]!.state).toMatchObject({ items: [{ id: "t1" }] });
      const sysInTree = branch1.filter(
        (e) => e.type === "message" && JSON.stringify(e.message).includes("SYS-PROMPT-MARKER"),
      );
      expect(sysInTree).toHaveLength(0);

      // Run 2: a NEW one-shot Worker (different PID) over the same session.
      const wake = await persistBackend.send(started.session, {
        history: [],
        input: {
          inputId: "in-p2",
          message: { role: "user", text: "second" },
          productEntryId: "pe-2",
        },
        run: {
          runId: "run-p-2",
          model: { backendKind: "coding_agent", modelId: "fake/echo" },
          productTools: [],
          configRevision: 2,
        },
        mode: "follow_up",
        metadata: { branchId: "b", productRevision: 2 },
      });
      // Capture Run 2's worker PID at acceptance, then await its outcome.
      const pid2 = persistSup
        .listSessions()
        .find((v) => v.backendSessionId === started.session.backendSessionId)?.workerPid;
      expect(pid2).not.toBeNull();
      expect(pid2).not.toBe(pid1); // a NEW worker process per Run
      const wakeOutcome = await wake.outcome;
      expect(wakeOutcome.status).toBe("completed");

      // Fidelity after the second Worker: pe-1 still exactly once, pe-2 exactly once (the
      // same canonical Message is never persisted twice), and run 1's todo
      // entry is still on the branch.
      const branch2 = await readBranch();
      expect(await countProductEntry("pe-1")).toBe(1);
      expect(await countProductEntry("pe-2")).toBe(1);
      const todosAfter = branch2.filter((e) => e.type === "todo") as Array<{
        state: Record<string, unknown>;
      }>;
      // Run 1's todo entry survived the Worker replacement. (The wake run may or may not
      // append a second todo_write: its first model turn can be consumed by
      // the threshold compaction that the oversized prompt triggers.)
      expect(todosAfter.length).toBeGreaterThanOrEqual(1);
      expect(todosAfter[0]!.state).toMatchObject({ items: [{ id: "t1" }] });

      // Idempotent replay of the ORIGINAL start must not append a second
      // batch: same inputId -> same session, no new prompt entry.
      const countPrompts = (branch: readonly CodingSessionEntry[]) =>
        branch.filter((e) => e.type === "message" && e.source === "prompt").length;
      const promptsBefore = countPrompts(branch2);
      const replay = await persistBackend.start({
        history: [],
        input: {
          inputId: "in-p1",
          message: { role: "user", text: `first ${"y".repeat(900_000)}` },
          productEntryId: "pe-1",
        },
        run: {
          runId: "run-p-1",
          model: { backendKind: "coding_agent", modelId: "fake/echo" },
          productTools: [],
          systemPrompt: "SYS-PROMPT-MARKER",
          configRevision: 1,
        },
        workspace: { root: `${persistTmp}/ws`, access: "read_write" },
        metadata: { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 1 },
      });
      expect(replay.session.backendSessionId).toBe(started.session.backendSessionId);
      const promptsAfter = countPrompts(await readBranch());
      expect(promptsAfter).toBe(promptsBefore);

      // Manual compact: the compaction entry persists (covers old entries)
      // and survives the following read.
      await persistClient.compactSession(started.session.backendSessionId, {
        idempotencyKey: `compact-${started.session.backendSessionId}`,
        commandId: `compact-${started.session.backendSessionId}`,
      });
      const summaries = (await readBranch()).filter((e) => e.type === "compaction") as Array<{
        coversEntryIds: readonly string[];
      }>;
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries[0]!.coversEntryIds.length).toBeGreaterThan(0);

      await persistBackend.close(started.session);
    } finally {
      persistServer.stop();
      await persistApp.stop();
      rmSync(persistTmp, { recursive: true, force: true });
    }
  }, 30_000);

  test("cold resume opens an existing session but refuses a missing one", async () => {
    // The nativeResume contract: resume never creates a fresh session. With
    // no in-memory record (as after a daemon restart) the Worker must OPEN
    // the existing SQLite file; a missing file must fail with not_found, not
    // silently start with empty context.
    const tmp3 = `/tmp/coding-resume-${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(`${tmp3}/ws`, { recursive: true });
    const resumeConfig = loadConfig({
      CODING_AGENT_AUTH_TOKEN: "token-123",
      CODING_AGENT_DATA_DIR: tmp3,
      CODING_AGENT_WORKSPACE_ROOTS: `${tmp3}/ws`,
      CODING_AGENT_FAKE_PROVIDER: "1",
    });
    const resumeRuntime = createModelRuntime();
    const resumeSup = createCodingSessionSupervisor({
      workerEntry: join(import.meta.dir, "..", "worker-main.ts"),
      cwd: tmp3,
      sessionsDir: `${tmp3}/sessions`,
      authEnv: { ...resumeConfig.providerEnv, CODING_AGENT_FAKE_PROVIDER: "1" },
      eventBufferSize: 100,
      workerStopGraceMs: 500,
      acceptTimeoutMs: 10_000,
      workspaceRoots: resumeConfig.workspaceRoots,
      maxStartingWorkers: 4,
      modelRuntime: resumeRuntime,
    });
    const resumeApp = createCodingAgentApp({
      config: resumeConfig,
      modelRuntime: resumeRuntime,
      supervisor: resumeSup,
    });
    const resumeServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: resumeApp.fetch,
    });
    const resumeClient = new CodingAgentClient({
      baseUrl: `http://127.0.0.1:${resumeServer.port}`,
      authToken: "token-123",
    });
    const resumeBackend = new CodingAgentBackend(resumeClient);
    try {
      const started = await resumeBackend.start({
        history: [],
        input: { inputId: "in-r1", message: { role: "user", text: "first" } },
        run: {
          runId: "run-r-1",
          model: { backendKind: "coding_agent", modelId: "fake/echo" },
          productTools: [],
          configRevision: 1,
        },
        workspace: { root: `${tmp3}/ws`, access: "read_write" },
        metadata: { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 1 },
      });
      const out1 = await started.segment.outcome;
      expect(out1.status).toBe("completed");
      const sid = started.session.backendSessionId;

      // Close WITHOUT deleting the session file, then cold-resume: the new
      // Worker must open the existing session (state preserved, run works).
      await resumeClient.closeSession(sid, false);
      const resumed = await resumeBackend.resume(sid, {
        history: [],
        input: { inputId: "in-r2", message: { role: "user", text: "again" } },
        run: {
          runId: "run-r-2",
          model: { backendKind: "coding_agent", modelId: "fake/echo" },
          productTools: [],
          configRevision: 2,
        },
        workspace: { root: `${tmp3}/ws`, access: "read_write" },
        metadata: { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 2 },
      });
      expect(resumed.session.backendSessionId).toBe(sid);
      const out2 = await resumed.segment.outcome;
      expect(out2.status).toBe("completed");
      await resumeClient.closeSession(sid, false);

      // Resume of a NEVER-EXISTED session must fail with not_found - the
      // daemon must not silently create it.
      const phantom = await resumeBackend
        .resume("no-such-session-id", {
          history: [],
          input: { inputId: "in-r3", message: { role: "user", text: "x" } },
          run: {
            runId: "run-r-3",
            model: { backendKind: "coding_agent", modelId: "fake/echo" },
            productTools: [],
            configRevision: 3,
          },
          workspace: { root: `${tmp3}/ws`, access: "read_write" },
          metadata: { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 3 },
        })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(phantom).not.toBeNull();
      expect((phantom as { code?: string }).code).toBe("not_found");
    } finally {
      resumeServer.stop();
      await resumeApp.stop();
      rmSync(tmp3, { recursive: true, force: true });
    }
  }, 30_000);
});
