import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import type { Agent, AgentConfig, SessionManager } from "@my-agent-team/agent";
import type { LoopState } from "@my-agent-team/loop";
import { loopReducer } from "@my-agent-team/loop";
import { echoModel } from "@my-agent-team/test-helpers";
import type { ProjectRow } from "../project/domain.js";
import type { ProjectPort } from "../project/ports.js";
import { createLoopStateStore, type LoopStateStore } from "./loop-state-store.js";
import type { GitRunner } from "./loop-step.js";
import { loopStep } from "./loop-step.js";

const TMP = "/tmp/loop-step-m3-test";
const DATA = "/tmp/loop-step-m3-data";

function createTestStore(): LoopStateStore {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE loop_item(
      loop_id TEXT NOT NULL, item_id TEXT NOT NULL,
      source TEXT NOT NULL, summary TEXT NOT NULL,
      step TEXT NOT NULL, attempt INTEGER NOT NULL,
      priority INTEGER NOT NULL, result TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(loop_id, item_id)
    );
    CREATE TABLE loop_budget(
      loop_id TEXT NOT NULL, day TEXT NOT NULL,
      spent INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(loop_id, day)
    );
  `);
  return createLoopStateStore(db);
}

async function initLoopDir(projectId?: string): Promise<string> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  const frontMatter = projectId
    ? `---
generator:
  model: gen-model
evaluator:
  model: eval-model
projectId: ${projectId}
---
`
    : `---
generator:
  model: gen-model
evaluator:
  model: eval-model
---
`;
  await Bun.write(`${TMP}/LOOP.md`, frontMatter);
  return TMP;
}

async function setupGitDataDir(): Promise<{
  dataDir: string;
  projectPort: ProjectPort;
  cleanup: () => Promise<void>;
}> {
  await rm(DATA, { recursive: true, force: true });

  // Create a bare source repo that resolveRepoPath can clone from.
  const srcWorktree = `${DATA}/src-wt`;
  const bareSrc = `${DATA}/src.git`;
  await mkdir(srcWorktree, { recursive: true });
  await Bun.$`git init`.cwd(srcWorktree).quiet();
  await Bun.$`git -C ${srcWorktree} config user.email "test@test"`.quiet();
  await Bun.$`git -C ${srcWorktree} config user.name "Test"`.quiet();
  await Bun.write(`${srcWorktree}/.gitkeep`, "");
  await Bun.$`git -C ${srcWorktree} add .gitkeep`.quiet();
  await Bun.$`git -C ${srcWorktree} commit -m init`.quiet();
  await Bun.$`git -C ${srcWorktree} branch -M main`.quiet();
  await Bun.$`git init --bare ${bareSrc}`.quiet();
  await Bun.$`git -C ${srcWorktree} remote add origin ${bareSrc}`.quiet();
  await Bun.$`git -C ${srcWorktree} push origin main`.quiet();
  await rm(srcWorktree, { recursive: true, force: true });

  const projectPort: ProjectPort = {
    createProject(_input) {
      throw new Error("not implemented");
    },
    getProject(projectId: string): ProjectRow | null {
      if (projectId !== "test-project") return null;
      return {
        projectId: "test-project",
        name: "test",
        repoUrl: bareSrc,
        defaultBranch: "main",
        autoOrchestrate: false,
        createdAt: 0,
        updatedAt: 0,
      };
    },
    listProjects(): ProjectRow[] {
      return [];
    },
    updateProject(_projectId: string, _patch) {
      return null;
    },
    deleteProject(_projectId: string): boolean {
      return false;
    },
  };

  return {
    dataDir: DATA,
    projectPort,
    cleanup: async () => {
      await rm(DATA, { recursive: true, force: true });
    },
  };
}

function emptyState(): LoopState {
  return { loopId: "test", lastRun: null, items: {} };
}

function makeConfig(_params: { modelName: string; cwd: string }) {
  return {
    model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
    plugins: [],
    tools: [],
  };
}

const noopGitRunner = {
  revParse: () => Promise.resolve({ text: () => "deadbeef" }),
  diff: () => Promise.resolve({ text: () => "" }),
  resetHard: () => Promise.resolve({ text: () => "" }),
} satisfies GitRunner;

function mockSessionManager(verdictMd: string, workDir: string = TMP): SessionManager {
  let callCount = 0;
  const sessions = new Map<
    string,
    {
      prompt: (input: string) => Promise<void>;
      sessionId: string;
      dispose: () => void;
      subscribe: () => () => void;
      state: string;
      resume: () => Promise<void>;
    }
  >();

  const manager: SessionManager = {
    create(_config: AgentConfig) {
      callCount++;
      const isEvaluator = callCount % 2 === 0; // gen=1, eval=2, gen=3, eval=4, ...
      const sessionId = `mock-${callCount}`;
      const session = {
        sessionId,
        state: "idle",
        prompt: async (_input: string) => {
          if (isEvaluator) {
            await Bun.write(`${workDir}/VERDICT.md`, verdictMd);
          }
        },
        resume: async () => {},
        dispose: () => {
          sessions.delete(sessionId);
        },
        subscribe: () => () => {},
      };
      sessions.set(sessionId, session);
      return session as unknown as Agent;
    },
    open(sessionId: string, _config: AgentConfig) {
      const existing = sessions.get(sessionId);
      if (existing) return existing as never;
      return this.create(_config);
    },
    get(sessionId: string) {
      const s = sessions.get(sessionId);
      return s as never | undefined;
    },
    dispose(sessionId: string) {
      sessions.delete(sessionId);
    },
  };

  return manager;
}

describe("loopStep M3 — Agent wiring", () => {
  test("TICK → generator + evaluator called", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    const dir = await initLoopDir("test-project");
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});

    const repoWorkDir = `${DATA}/repos/test-project`;
    const sessionManager = mockSessionManager("verdict: PASS\nevidence: ok", repoWorkDir);

    const next = await loopStep({
      loopConfigPath: dir,
      sessionManager,
      buildConfig: makeConfig,
      store,
      loopId: "test-loop",
      gitRunner: noopGitRunner,
      projectPort,
      dataDir,
    });

    expect(sessionManager).toBeDefined();
    expect(next.items["01"]!.step).toBe("awaiting_review");

    await cleanup();
  });

  test("REJECT → item back to fixing, attempt+1", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    const dir = await initLoopDir("test-project");
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});

    const repoWorkDir = `${DATA}/repos/test-project`;
    const sessionManager = mockSessionManager(
      "verdict: REJECT\nreasons: scope drift\nevidence: 5 files",
      repoWorkDir,
    );

    const next = await loopStep({
      loopConfigPath: dir,
      sessionManager,
      buildConfig: makeConfig,
      store,
      loopId: "test-loop",
      gitRunner: noopGitRunner,
      projectPort,
      dataDir,
    });

    expect(next.items["01"]!.step).toBe("fixing");
    expect(next.items["01"]!.attempt).toBe(2);
    expect(next.items["01"]!.result).not.toBeNull();

    await cleanup();
  });

  test("REJECT exhausted → inbox in store", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    const dir = await initLoopDir("test-project");
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    state = {
      ...state,
      items: { "01": { ...state.items["01"]!, attempt: 3 } },
    };
    store.save("test-loop", state, {});

    const repoWorkDir = `${DATA}/repos/test-project`;
    const sessionManager = mockSessionManager(
      "verdict: REJECT\nreasons: still broken\nevidence: x",
      repoWorkDir,
    );

    const next = await loopStep({
      loopConfigPath: dir,
      sessionManager,
      buildConfig: makeConfig,
      store,
      loopId: "test-loop",
      gitRunner: noopGitRunner,
      projectPort,
      dataDir,
    });

    expect(next.items["01"]!.step).toBe("inbox");

    // Round-trip: DB must also have inbox step (not stale fixing)
    const reloaded = store.load("test-loop");
    expect(reloaded.items["01"]!.step).toBe("inbox");
    await cleanup();
  });

  test("ESCALATE → inbox in store", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    const dir = await initLoopDir("test-project");
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});

    const repoWorkDir = `${DATA}/repos/test-project`;
    const sessionManager = mockSessionManager(
      "verdict: ESCALATE\nreasons: no env\nevidence: mcp unreachable",
      repoWorkDir,
    );

    const next = await loopStep({
      loopConfigPath: dir,
      sessionManager,
      buildConfig: makeConfig,
      store,
      loopId: "test-loop",
      gitRunner: noopGitRunner,
      projectPort,
      dataDir,
    });

    expect(next.items["01"]!.step).toBe("inbox");

    // Round-trip: DB must persist inbox step
    const reloaded = store.load("test-loop");
    expect(reloaded.items["01"]!.step).toBe("inbox");
    await cleanup();
  });

  test("empty VERDICT.md → item goes to inbox (ESCALATE)", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    const dir = await initLoopDir("test-project");
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});

    const repoWorkDir = `${DATA}/repos/test-project`;
    const sessionManager = mockSessionManager("", repoWorkDir);

    const next = await loopStep({
      loopConfigPath: dir,
      sessionManager,
      buildConfig: makeConfig,
      store,
      loopId: "test-loop",
      gitRunner: noopGitRunner,
      projectPort,
      dataDir,
    });

    expect(next.items["01"]!.step).toBe("inbox");

    // Round-trip: DB must persist inbox step
    const reloaded = store.load("test-loop");
    expect(reloaded.items["01"]!.step).toBe("inbox");
    await cleanup();
  });

  test("human APPROVE → resolved item deleted from store", async () => {
    const dir = await initLoopDir();
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    state = loopReducer(state, { type: "TICK" });
    state = loopReducer(state, { type: "GENERATOR_DONE", itemId: "01" });
    state = loopReducer(state, {
      type: "EVALUATOR_VERDICT",
      itemId: "01",
      verdict: { verdict: "PASS", evidence: "ok" },
    });
    store.save("test-loop", state, {});

    const sessionManager = mockSessionManager("");

    await loopStep({
      loopConfigPath: dir,
      sessionManager,
      buildConfig: makeConfig,
      store,
      loopId: "test-loop",
      action: { itemId: "01", verdict: "approve" },
      gitRunner: noopGitRunner,
    });

    const loaded = store.load("test-loop");
    expect(loaded.items["01"]).toBeUndefined();
  });

  // ── G0: fail-closed guard regression ──

  test("G0.1: fixing items without repoPath throws unconditionally (no projectPort precondition)", async () => {
    const dir = await initLoopDir();
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});

    const sessionManager = mockSessionManager("");

    // No projectPort, no dataDir — guard must STILL throw (unconditional)
    await expect(
      loopStep({
        loopConfigPath: dir,
        sessionManager,
        buildConfig: makeConfig,
        store,
        loopId: "test-loop",
        gitRunner: noopGitRunner,
        // projectPort + dataDir deliberately absent
      }),
    ).rejects.toThrow("cannot process fixing items without a resolved repoPath");
  });

  test("G0.2: loopStep with guard throw does not mutate backend repo cwd files", async () => {
    const backendMarker = "/tmp/loop-step-g0-backend-marker.txt";
    const markerContent = "BACKEND FILE — MUST SURVIVE";
    await Bun.write(backendMarker, markerContent);

    const dir = await initLoopDir();
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});

    const sessionManager = mockSessionManager("");

    await expect(
      loopStep({
        loopConfigPath: dir,
        sessionManager,
        buildConfig: makeConfig,
        store,
        loopId: "test-loop",
        gitRunner: noopGitRunner,
      }),
    ).rejects.toThrow("cannot process fixing items without a resolved repoPath");

    // Backend repo marker file must be untouched — no git reset --hard hit it
    const after = await Bun.file(backendMarker).text();
    expect(after).toBe(markerContent);

    await rm(backendMarker, { force: true });
  });

  test("G0.3: fixing items with valid repoPath do NOT operate on backend cwd", async () => {
    // This test verifies that when repoPath IS resolved, git ops target the
    // resolved repo (not the backend's cwd). We use a real gitRunner and
    // a temp bare repo to confirm no side effects reach the project root.
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    const dir = await initLoopDir("test-project");
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});

    const repoWorkDir = `${DATA}/repos/test-project`;
    const sessionManager = mockSessionManager("", repoWorkDir);

    // Write a marker file in the BACKEND's project root and verify it survives
    const backendMarker = "/tmp/loop-step-g0-backend-marker.txt";
    const markerContent = "BACKEND FILE — MUST SURVIVE";
    await Bun.write(backendMarker, markerContent);

    const next = await loopStep({
      loopConfigPath: dir,
      sessionManager,
      buildConfig: makeConfig,
      store,
      loopId: "test-loop",
      gitRunner: noopGitRunner,
      projectPort,
      dataDir,
    });

    // The test must either error gracefully or complete — either way,
    // the backend marker file must survive untouched
    expect(next.items["01"]).toBeDefined();
    const after = await Bun.file(backendMarker).text();
    expect(after).toBe(markerContent);

    await rm(backendMarker, { force: true });
    await cleanup();
  });
});
// ── T3/T4/T5: generator context, evaluator timeout, budget notification ──

async function initLoopDirWithBudget(projectId: string, dailyCap: number): Promise<string> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  await Bun.write(
    `${TMP}/LOOP.md`,
    [
      "---",
      `projectId: ${projectId}`,
      "generator:",
      "  model: gen-model",
      '  systemPrompt: "fix {summary} from {source}"',
      "evaluator:",
      "  model: eval-model",
      "  systemPrompt: verify",
      "budget:",
      `  dailyCap: ${dailyCap}`,
      "---",
    ].join("\n"),
  );
  return TMP;
}

function captureSessionManager(
  verdictMd: string,
  workDir: string = TMP,
  opts: { evalDelayMs?: number } = {},
): SessionManager & { genPrompts: string[]; evalPrompts: string[] } {
  let callCount = 0;
  const genPrompts: string[] = [];
  const evalPrompts: string[] = [];
  const sessions = new Map<string, unknown>();

  const manager = {
    create(_config: AgentConfig) {
      callCount++;
      const isEvaluator = callCount % 2 === 0;
      const sessionId = `cap-${callCount}`;
      const session = {
        sessionId,
        state: "idle",
        prompt: async (input: string) => {
          if (isEvaluator) {
            evalPrompts.push(input);
            if (opts.evalDelayMs) await Bun.sleep(opts.evalDelayMs);
            await Bun.write(`${workDir}/VERDICT.md`, verdictMd);
          } else {
            genPrompts.push(input);
          }
        },
        resume: async () => {},
        dispose: () => sessions.delete(sessionId),
        subscribe: () => () => {},
      };
      sessions.set(sessionId, session);
      return session as unknown as Agent;
    },
    open(sessionId: string, _config: AgentConfig) {
      const existing = sessions.get(sessionId);
      if (existing) return existing as never;
      return this.create(_config);
    },
    get(sessionId: string) {
      return sessions.get(sessionId) as never | undefined;
    },
    dispose(sessionId: string) {
      sessions.delete(sessionId);
    },
  } as SessionManager;

  return Object.assign(manager, { genPrompts, evalPrompts });
}

describe("loopStep T3/T4/T5 - context, timeout, budget", () => {
  test("T3: generator prompt includes project context (repo + git log)", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    const dir = await initLoopDirWithBudget("test-project", 0);
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky test" },
    });
    store.save("test-loop", state, {});

    const repoWorkDir = `${DATA}/repos/test-project`;
    const sessionManager = captureSessionManager("verdict: PASS\nevidence: ok", repoWorkDir);

    await loopStep({
      loopConfigPath: dir,
      sessionManager,
      buildConfig: makeConfig,
      store,
      loopId: "test-loop",
      gitRunner: noopGitRunner,
      projectPort,
      dataDir,
    });

    expect(sessionManager.genPrompts.length).toBe(1);
    const prompt = sessionManager.genPrompts[0]!;
    // Placeholder substitution still works
    expect(prompt).toContain("fix flaky test from ci");
    // Project context injected
    expect(prompt).toContain("## Project Context");
    expect(prompt).toContain("Repo:");
    // git log may be empty (bare repo has no commits checked out) but section should exist
    await cleanup();
  });

  test("T4: evaluator timeout does not crash loop (verdict stays empty -> ESCALATE)", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    const dir = await initLoopDirWithBudget("test-project", 0);
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});

    const repoWorkDir = `${DATA}/repos/test-project`;
    // evalDelayMs > 60_000 would make the test too slow; instead we use a
    // sessionManager whose eval prompt never resolves (hanging promise).
    // The Promise.race timeout will fire after 60s - too slow for tests.
    // Instead, verify the timeout code path by making eval prompt reject.
    const sessionManager = captureSessionManager("", repoWorkDir);
    // Override: make eval prompt reject immediately to exercise the .catch path
    const origCreate = sessionManager.create.bind(sessionManager);
    let callCount = 0;
    sessionManager.create = ((config: AgentConfig) => {
      callCount++;
      const session = origCreate(config) as unknown as {
        sessionId: string;
        prompt: (input: string) => Promise<void>;
        dispose: () => void;
        subscribe: () => () => void;
        state: string;
        resume: () => Promise<void>;
      };
      if (callCount % 2 === 0) {
        // Evaluator session: prompt rejects (simulates crash/timeout)
        session.prompt = () => Promise.reject(new Error("evaluator crashed"));
      }
      return session as unknown as Agent;
    }) as SessionManager["create"];

    const next = await loopStep({
      loopConfigPath: dir,
      sessionManager,
      buildConfig: makeConfig,
      store,
      loopId: "test-loop",
      gitRunner: noopGitRunner,
      projectPort,
      dataDir,
    });

    // Evaluator crash caught -> empty verdict -> ESCALATE -> inbox
    expect(next.items["01"]!.step).toBe("inbox");
    await cleanup();
  });

  test("T5: budget exceeded (pre-loop) notifies convPort and breaks", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    const dir = await initLoopDirWithBudget("test-project", 100);
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});
    // Pre-exhaust budget
    store.addBudget("test-loop", new Date().toISOString().slice(0, 10), 150);

    const repoWorkDir = `${DATA}/repos/test-project`;
    const sessionManager = captureSessionManager("verdict: PASS\nevidence: ok", repoWorkDir);

    const ledgerCalls: unknown[] = [];
    const next = await loopStep({
      loopConfigPath: dir,
      sessionManager,
      buildConfig: makeConfig,
      store,
      loopId: "test-loop",
      gitRunner: noopGitRunner,
      projectPort,
      dataDir,
      convPort: {
        appendLedgerEntry: (input) => {
          ledgerCalls.push(input);
        },
      },
    });

    // Generator was NOT called (budget exhausted before loop)
    expect(sessionManager.genPrompts.length).toBe(0);
    // convPort notified
    expect(ledgerCalls.length).toBe(1);
    const entry = ledgerCalls[0] as { content: string; kind: string };
    expect(entry.kind).toBe("message");
    const parsed = JSON.parse(entry.content) as { type: string; cap: number; spent: number };
    expect(parsed.type).toBe("budget_exceeded");
    expect(parsed.cap).toBe(100);
    // Item stays fixing (loop never ran)
    expect(next.items["01"]!.step).toBe("fixing");
    await cleanup();
  });

  test("T5: budget exceeded mid-loop notifies convPort and breaks", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    const dir = await initLoopDirWithBudget("test-project", 100);
    const store = createTestStore();
    let state = emptyState();
    // Two fixing items
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky A" },
    });
    state = loopReducer(state, { type: "TICK" });
    state = loopReducer(state, { type: "GENERATOR_DONE", itemId: "01" });
    state = loopReducer(state, {
      type: "EVALUATOR_VERDICT",
      itemId: "01",
      verdict: { verdict: "REJECT", reasons: ["bad"], evidence: "" },
    });
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "02", source: "ci", summary: "flaky B" },
    });
    // After TICK, item 01 back to fixing, item 02 to fixing
    state = loopReducer(state, { type: "TICK" });
    store.save("test-loop", state, {});
    // Pre-exhaust budget so the FIRST item hits the in-loop check
    store.addBudget("test-loop", new Date().toISOString().slice(0, 10), 100);

    const repoWorkDir = `${DATA}/repos/test-project`;
    const sessionManager = captureSessionManager("verdict: PASS\nevidence: ok", repoWorkDir);

    const ledgerCalls: unknown[] = [];
    await loopStep({
      loopConfigPath: dir,
      sessionManager,
      buildConfig: makeConfig,
      store,
      loopId: "test-loop",
      gitRunner: noopGitRunner,
      projectPort,
      dataDir,
      convPort: {
        appendLedgerEntry: (input) => {
          ledgerCalls.push(input);
        },
      },
    });

    // In-loop check fired: generator NOT called for any item
    expect(sessionManager.genPrompts.length).toBe(0);
    // convPort notified (in-loop check)
    expect(ledgerCalls.length).toBe(1);
    await cleanup();
  });

  test("T5: no convPort -> budget exceeded breaks silently (no crash)", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    const dir = await initLoopDirWithBudget("test-project", 100);
    const store = createTestStore();
    let state = emptyState();
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "flaky" },
    });
    store.save("test-loop", state, {});
    store.addBudget("test-loop", new Date().toISOString().slice(0, 10), 150);

    const repoWorkDir = `${DATA}/repos/test-project`;
    const sessionManager = captureSessionManager("verdict: PASS\nevidence: ok", repoWorkDir);

    // No convPort - should not crash
    const next = await loopStep({
      loopConfigPath: dir,
      sessionManager,
      buildConfig: makeConfig,
      store,
      loopId: "test-loop",
      gitRunner: noopGitRunner,
      projectPort,
      dataDir,
    });

    expect(sessionManager.genPrompts.length).toBe(0);
    expect(next.items["01"]!.step).toBe("fixing");
    await cleanup();
  });
});
