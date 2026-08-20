import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRunOutcome } from "@chengchenccc/agent-backend";
import type { LoopState } from "@chengchenccc/loop";
import { loopReducer } from "@chengchenccc/loop";
import type { AgentRun } from "../agent-run/domain.js";
import type { AgentRunExecutionService } from "../agent-run/execution.js";
import type { AgentRunService } from "../agent-run/service.js";
import type { ProjectRow } from "../project/domain.js";
import type { ProjectPort } from "../project/ports.js";
import { createWorkspaceLockRegistry } from "../project/workspace-lock.js";
import { createLoopStateStore, type LoopStateStore } from "./loop-state-store.js";
import type { GitRunner } from "./loop-step.js";
import { loopCleanStart, loopStep } from "./loop-step.js";

// Every test gets its own mkdtemp dirs — no shared fixed /tmp paths, so the
// file is safe under full-suite parallel execution (a shared dir would let one
// test's cleanup delete another test's git repo mid-flight).

function createTestStore(): LoopStateStore {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE loop_item(
      loop_id TEXT NOT NULL, item_id TEXT NOT NULL,
      source TEXT NOT NULL, summary TEXT NOT NULL,
      step TEXT NOT NULL, attempt INTEGER NOT NULL,
      priority INTEGER NOT NULL, result TEXT,
      generator_run_id TEXT, evaluator_run_id TEXT,
      task_class TEXT, defer TEXT,
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

async function initLoopDir(
  projectId?: string,
  denylist?: string,
  budgetYaml?: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "loop-step-"));
  const denylistYaml = denylist ? `denylist:\n${denylist}\n` : "";
  const budget = budgetYaml ? `budget:\n${budgetYaml}\n` : "";
  const frontMatter = `---
model: gen-model
acceptance: "tests pass"
${projectId ? `projectId: ${projectId}\n` : ""}
${denylistYaml}${budget}---
`;
  await Bun.write(`${dir}/LOOP.md`, frontMatter);
  return dir;
}

async function setupGitDataDir(): Promise<{
  dataDir: string;
  projectPort: ProjectPort;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "loop-step-data-"));

  const srcWorktree = `${root}/src-wt`;
  const bareSrc = `${root}/src.git`;
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
    createProject() {
      throw new Error("not implemented");
    },
    getProject(projectId: string): ProjectRow | null {
      if (projectId !== "test-project") return null;
      return {
        projectId: "test-project",
        name: "test",
        repoUrl: bareSrc,
        defaultBranch: "main",
        createdAt: 0,
        updatedAt: 0,
      };
    },
    listProjects(): ProjectRow[] {
      return [];
    },
    updateProject() {
      return null;
    },
    deleteProject(): boolean {
      return false;
    },
  };

  return {
    dataDir: root,
    projectPort,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function emptyState(): LoopState {
  return { loopId: "test", lastRun: null, items: {} };
}

// ── Fake Agent Run services ────────────────────────────────────────────────

interface RunScript {
  genStatus?: "completed" | "failed" | "commit_failed";
  /** Fail the Nth generator dispatch and every later one (per-item
   *  checkpoint tests: earlier items complete, a later one throws). */
  genFailAfter?: number;
  /** The verdict the fake workflow run "returns" as outcome.workflow.value.
   *  undefined = a default PASS verdict; null = no usable verdict. */
  workflowVerdict?: {
    verdict: "PASS" | "REJECT" | "ESCALATE";
    evidence?: string;
    reasons?: string[];
  } | null;
  /** Real files the fake generator touches inside the worktree (A2:
   *  denylist sees untracked files through porcelain). */
  touchFiles?: string[];
  /** usage tokens returned on both runs. */
  usageTokens?: number;
  /** generator rejects the input (queued behind another run). */
  genQueued?: boolean;
  /** first generator enqueue REPLAYS a terminal failed run; the retry-scoped
   *  key must then acquire a FRESH run. */
  genReplayTerminal?: boolean;
  /** Observe every enqueue (idempotency keys) even when loopStep throws. */
  onEnqueue?: (e: { agentMemberId: string; idempotencyKey: string }) => void;
}

function makeFakeRuns(script: RunScript, workDir: string = "") {
  const enqueues: Array<{
    conversationId: string;
    agentMemberId: string;
    mode: string;
    idempotencyKey: string;
    message: { text?: string };
    workflow?: { script: string };
  }> = [];
  let runSeq = 0;
  const runs = new Map<string, AgentRun>();

  const makeRun = (member: string, conv: string, ikey: string): AgentRun => {
    const runId = `run-${++runSeq}`;
    const run: AgentRun = {
      runId,
      branchId: `b-${runId}`,
      conversationId: conv,
      agentMemberId: member,
      modelRef: { backendKind: "oma", modelId: "m" },
      status: "completed",
      idempotencyKey: ikey,
      terminalResult: null,
      configRevision: 1,
      productTools: null,
      systemPrompt: null,
      skillRoots: null,
      permissionMode: null,
      todoSnapshot: null,
      workspace: null,
      workflowBudgetTokens: null,
      workflow: null,
      createdAt: 0,
      terminalAt: null,
    };
    runs.set(runId, run);
    return run;
  };

  const agentRunService: AgentRunService = {
    async enqueueAndAcquire(input) {
      enqueues.push({
        conversationId: input.conversationId,
        agentMemberId: input.agentMemberId,
        mode: input.mode,
        idempotencyKey: input.idempotencyKey,
        message: input.message as { text?: string },
        ...(input.workflow ? { workflow: { script: input.workflow.script } } : {}),
      });
      script.onEnqueue?.({
        agentMemberId: input.agentMemberId,
        idempotencyKey: input.idempotencyKey,
      });
      if (script.genQueued && input.agentMemberId.startsWith("loop-generator")) {
        return { acquired: false, queued: true, replayed: false, inputId: "in" };
      }
      if (
        script.genReplayTerminal &&
        input.agentMemberId.startsWith("loop-generator") &&
        !input.idempotencyKey.includes(":retry")
      ) {
        const old = makeRun(input.agentMemberId, input.conversationId, input.idempotencyKey);
        (old as { status: AgentRun["status"] }).status = "failed";
        return {
          acquired: false,
          queued: false,
          replayed: true,
          run: old,
          inputId: `in-${old.runId}`,
        };
      }
      const run = makeRun(input.agentMemberId, input.conversationId, input.idempotencyKey);
      return { acquired: true, queued: false, replayed: false, run, inputId: `in-${run.runId}` };
    },
    async markInputAccepted(inputId) {
      return { inputId } as never;
    },
    async createPendingAction(runId, action) {
      return { runId, actionId: "a", ...action } as never;
    },
    async consumePendingAction(actionId) {
      return { action: { actionId } as never, runId: "r" };
    },
    async finalizeRun(runId) {
      return runs.get(runId)!;
    },
    async getRun(runId) {
      return runs.get(runId) ?? null;
    },
    async getActiveRun() {
      return null;
    },
    async listInputs() {
      return [];
    },
    async getInput() {
      return null;
    },
    async listPendingInputsForConversation() {
      return [];
    },
    async updateInput() {
      return false;
    },
    async cancelInput() {},
    async hasActiveRunForConversations() {
      return false;
    },
    async listActiveRunsForConversations() {
      return [];
    },
  };

  let genDispatches = 0;
  const agentRunExecution: AgentRunExecutionService = {
    async dispatch(runId) {
      const run = runs.get(runId);
      if (!run) return;
      if (run.agentMemberId.startsWith("loop-generator")) {
        genDispatches++;
        if (script.genFailAfter !== undefined && genDispatches > script.genFailAfter) {
          (run as { status: AgentRun["status"] }).status = "failed";
          (run as { terminalResult: BackendRunOutcome | null }).terminalResult = {
            status: "failed",
            error: "boom",
          } as BackendRunOutcome;
          return;
        }
      }
      // A2: touch files at dispatch time — the worktree exists now and
      // porcelain picks them up as untracked.
      for (const rel of script.touchFiles ?? []) {
        await Bun.write(join(workDir, rel), "touched").catch(() => {
          /* fixture without a worktree */
        });
      }
      const status = script.genStatus ?? "completed";
      (run as { status: AgentRun["status"] }).status = status;
      const verdict =
        script.workflowVerdict === undefined
          ? { verdict: "PASS" as const, evidence: "e" }
          : script.workflowVerdict;
      (run as { terminalResult: BackendRunOutcome | null }).terminalResult = {
        status: status === "completed" ? "completed" : status,
        ...(status === "completed"
          ? {
              workflow: { ok: verdict !== null, value: verdict },
            }
          : {}),
        ...(script.usageTokens !== undefined
          ? { usage: { inputTokens: script.usageTokens, outputTokens: 0 } }
          : {}),
      } as BackendRunOutcome;
    },
    async recover() {},
    async injectSteer() {},
    async retryTerminalCommit() {},
    async stop() {},
    isLive() {
      return false;
    },
    isInflight() {
      return false;
    },
    async abortStaleRun() {},
    async dispose() {},
    subscribe() {
      return (async function* () {})();
    },
  };

  return { agentRunService, agentRunExecution, enqueues, runs };
}

const genConversationId = (loopId: string) => `loop:${loopId}:generator`;
async function runStep(
  overrides: Partial<{
    store: LoopStateStore;
    dir: string;
    dataDir: string;
    projectPort: ProjectPort;
    gitRunner: GitRunner;
    script: RunScript;
    action: Parameters<typeof loopStep>[0]["action"];
    convPort: Parameters<typeof loopStep>[0]["convPort"];
  }> = {},
) {
  const ownGit = !overrides.projectPort || !overrides.dataDir ? await setupGitDataDir() : null;
  const store = overrides.store ?? createTestStore();
  const dataDir = overrides.dataDir ?? ownGit!.dataDir;
  const projectPort = overrides.projectPort ?? ownGit!.projectPort;
  const dir = overrides.dir ?? (await initLoopDir("test-project"));
  // The loop step materializes the agent worktree at
  // <agentWs>/projects/<projectId>; the fake workflow meta write must land
  // there (the real seed does).
  const fake = makeFakeRuns(
    overrides.script ?? {},
    join(dataDir, "loop-agent-ws", "projects", "test-project"),
  );
  try {
    const result = await loopStep({
      loopConfigPath: dir,
      store,
      loopId: "test",
      convPort:
        overrides.convPort ??
        ({
          createConversation: () => ({}),
          addMember: () => ({ member: null, created: true }),
          getConversation: () => null,
          getMembers: () => [],
          appendLedgerEntry: () => 1,
        } as never),
      projectPort,
      dataDir,
      gitRunner: overrides.gitRunner,
      action: overrides.action,
      agentRunService: fake.agentRunService,
      agentRunExecution: fake.agentRunExecution,
      resolveModel: async (name) => ({ backendKind: "oma", modelId: name }),
      agentWorkspaceOf: async () => join(dataDir, "loop-agent-ws"),
      withWorkspaceLock: createWorkspaceLockRegistry().withLock.bind(createWorkspaceLockRegistry()),
    });
    return {
      result,
      ...fake,
      worktreeRoot: join(dataDir, "loop-agent-ws", "projects", "test-project"),
    };
  } finally {
    await ownGit?.cleanup();
    // The loop dir is always a per-test mkdtemp (created here or by the
    // caller); no test reads it after runStep returns.
    await rm(dir, { recursive: true, force: true });
  }
}

function stateWithFixingItem(store: LoopStateStore): LoopState {
  const state = loopReducer(emptyState(), {
    type: "ADD_ITEM",
    item: { id: "item-1", source: "issue", summary: "fix the thing" },
    priority: 3,
  });
  store.save("test", state, {});
  return state;
}

describe("loopStep — Generator/Evaluator as Agent Runs", () => {
  test("TICK → one generator run on its stable scope (no evaluator scope)", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    const { enqueues } = await runStep({ store });

    const gen = enqueues.find((e) => e.agentMemberId.startsWith("loop-generator"));
    expect(gen).toBeTruthy();
    expect(enqueues.some((e) => e.agentMemberId.startsWith("loop-evaluator"))).toBe(false);
    // deterministic generator identity
    expect(gen!.conversationId).toBe(genConversationId("test"));
    expect(gen!.mode).toBe("normal");
    expect(gen!.idempotencyKey).toContain("loop-gen:test:item-1:");
    // the workflow script is the run's product: fix + verify subagents
    expect(gen!.workflow?.script).toContain('agent("Fix the loop item');
    expect(gen!.workflow?.script).toContain("Verify the fix");
  });

  test("PASS verdict via workflow run → awaiting_review; generatorRunId persisted", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    await runStep({
      store,
      script: {
        workflowVerdict: { verdict: "PASS", evidence: "tests green" },
      },
    });

    const saved = store.load("test");
    const item = Object.values(saved.items)[0]!;
    expect(item.step).toBe("awaiting_review");
    // generatorRunId field now carries the Agent Run id; no evaluator run id
    expect(item.generatorRunId).toMatch(/^run-\d+$/);
    expect(item.evaluatorRunId).toBeFalsy();
    expect(item.result?.verdict).toBe("PASS");
  });

  test("state is checkpointed after each item (T4: mid-tick crash loses at most the current item)", async () => {
    const store = createTestStore();
    let state = loopReducer(emptyState(), {
      type: "ADD_ITEM",
      item: { id: "item-1", source: "issue", summary: "fix a" },
      priority: 3,
    });
    state = loopReducer(state, {
      type: "ADD_ITEM",
      item: { id: "item-2", source: "issue", summary: "fix b" },
      priority: 3,
    });
    store.save("test", state, {});
    const dir = await initLoopDir("test-project");
    // Item 1's generator completes (PASS); item 2's generator fails, so the
    // tick throws BEFORE the tail save. Only the per-item checkpoint
    // persisted item 1's verdict.
    await expect(runStep({ store, dir, script: { genFailAfter: 1 } })).rejects.toThrow(
      /ended failed/,
    );
    const saved = store.load("test");
    expect(saved.items["item-1"]?.step).toBe("awaiting_review");
    expect(saved.items["item-2"]?.step).toBe("fixing");
  });

  test("generator run queued → loopStep fails (no dispatch of a second run)", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    await expect(runStep({ store, script: { genQueued: true } })).rejects.toThrow(
      "could not acquire",
    );
  });

  test("generator failed → loopStep throws, evaluator never created", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    try {
      const dir = await initLoopDir("test-project");
      try {
        const fake = makeFakeRuns(
          { genStatus: "failed" },
          join(dataDir, "loop-agent-ws", "projects", "test-project"),
        );
        await expect(
          loopStep({
            loopConfigPath: dir,
            store,
            loopId: "test",
            projectPort,
            dataDir,
            convPort: {
              createConversation: () => ({}),
              addMember: () => ({ member: null, created: true }),
              getConversation: () => null,
              getMembers: () => [],
              appendLedgerEntry: () => 1,
            } as never,
            agentRunService: fake.agentRunService,
            agentRunExecution: fake.agentRunExecution,
            resolveModel: async (name) => ({ backendKind: "oma", modelId: name }),
            agentWorkspaceOf: async () => join(dataDir, "loop-agent-ws"),
            withWorkspaceLock: createWorkspaceLockRegistry().withLock.bind(
              createWorkspaceLockRegistry(),
            ),
          }),
        ).rejects.toThrow("generator run");
        expect(fake.enqueues.some((e) => e.agentMemberId.startsWith("loop-evaluator"))).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      await cleanup();
    }
  });

  test("terminal replay of a failed generator issues a FRESH run under a retry key", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    const { enqueues } = await runStep({
      store,
      script: { genReplayTerminal: true },
    });
    // first enqueue replayed the terminal run; the retry-scoped key acquired
    // a fresh run and the loop completed normally
    const genKeys = enqueues
      .filter((e) => e.agentMemberId.startsWith("loop-generator"))
      .map((e) => e.idempotencyKey);
    expect(genKeys).toHaveLength(2);
    expect(genKeys[1]).toContain(":retry");
    const saved = store.load("test");
    const item = Object.values(saved.items)[0]!;
    expect(item.generatorRunId).toMatch(/^run-\d+$/);
  });

  test("Bug 2: retry key differs across failure ticks (item.attempt is static)", async () => {
    const fixture = await setupGitDataDir();
    const seen: string[] = [];
    try {
      const store = createTestStore();
      stateWithFixingItem(store);
      const script = {
        genReplayTerminal: true,
        genStatus: "failed" as const,
        onEnqueue: (e: { idempotencyKey: string }) => seen.push(e.idempotencyKey),
      };
      // Generator fails after the retry enqueue: loopStep throws BEFORE any
      // state save, so attempt stays 1 on the next tick. The retry key must
      // still move forward, or the second tick replays the same dead run.
      await expect(
        runStep({ store, dataDir: fixture.dataDir, projectPort: fixture.projectPort, script }),
      ).rejects.toThrow(/ended failed/);
      await expect(
        runStep({ store, dataDir: fixture.dataDir, projectPort: fixture.projectPort, script }),
      ).rejects.toThrow(/ended failed/);
      const retryKeys = seen.filter((k) => k.includes(":retry"));
      expect(retryKeys).toHaveLength(2);
      expect(retryKeys[0]).not.toBe(retryKeys[1]);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  test("generator commit_failed → loopStep throws, evaluator never created", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    await expect(runStep({ store, script: { genStatus: "commit_failed" } })).rejects.toThrow(
      "commit_failed",
    );
  });

  test("REJECT verdict → item back to fixing, attempt+1, git rollback", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    const gitRunner: GitRunner = {
      revParse: () => Promise.resolve({ text: () => "deadbeef" }),
      diff: () => Promise.resolve({ text: () => "src/x.ts\n" }),
      resetHard: () => Promise.resolve({ text: () => "" }),
    };
    const { result } = await runStep({
      store,
      gitRunner,
      script: {
        workflowVerdict: { verdict: "REJECT", reasons: ["not good"], evidence: "e" },
      },
    });
    const item = result.items["item-1"]!;
    expect(item.step).toBe("fixing");
    expect(item.attempt).toBe(2);
  });

  test("denylist violation → REJECT without evaluator run", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    const dir = await initLoopDir("test-project", "        - .env");
    // A2: the violation is an UNTRACKED .env — porcelain must catch it
    // (the retired diff-based check could not).
    const { enqueues, result } = await runStep({
      store,
      dir,
      script: { touchFiles: [".env"] },
    });
    expect(enqueues.some((e) => e.agentMemberId.startsWith("loop-evaluator"))).toBe(false);
    expect(result.items["item-1"]!.result?.verdict).toBe("REJECT");
  });

  test("no usable workflow verdict → REJECT (acceptance never ran)", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    const { result } = await runStep({ store, script: { workflowVerdict: null } });
    const item = result.items["item-1"]!;
    expect(item.step).toBe("fixing");
    expect(item.result?.verdict).toBe("REJECT");
  });

  test("no verdict but files changed → REJECT + rollback, work NOT preserved", async () => {
    const fixture = await setupGitDataDir();
    try {
      const store = createTestStore();
      stateWithFixingItem(store);
      const { result, worktreeRoot } = await runStep({
        store,
        dataDir: fixture.dataDir,
        projectPort: fixture.projectPort,
        script: { workflowVerdict: null, touchFiles: ["CHANGE.txt"] },
      });
      const item = result.items["item-1"]!;
      // Hardened evaluation: no usable verdict = verification never ran.
      // Changed work is REJECTed and rolled back — never silently PASSed
      // into awaiting_review with unverified changes.
      expect(item.step).toBe("fixing");
      expect(item.result?.verdict).toBe("REJECT");
      const evidence = item.result && "evidence" in item.result ? item.result.evidence : "";
      expect(evidence).toContain("CHANGE.txt");
      // REJECT → resetHard: the change is gone, no PASS commit exists.
      expect(existsSync(join(worktreeRoot, "CHANGE.txt"))).toBe(false);
      const log = await Bun.$`git -C ${worktreeRoot} log --oneline -3`.quiet().text();
      expect(log).not.toMatch(/loop test item item-1/);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  test("human APPROVE → resolved item removed from store", async () => {
    const store = createTestStore();
    const state = loopReducer(
      {
        ...emptyState(),
        items: {
          "item-1": {
            id: "item-1",
            source: "issue",
            summary: "s",
            step: "awaiting_review",
            attempt: 1,
            priority: 3,
            result: { verdict: "PASS", reasons: [], evidence: "e" } as never,
          },
        },
      },
      { type: "TICK" },
    );
    store.save("test", state, {});
    await runStep({
      store,
      action: { itemId: "item-1", verdict: "approve" },
    });
    expect(store.load("test").items["item-1"]).toBeUndefined();
  });

  test("usage from terminalResult feeds the daily budget", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    const dir = await initLoopDir("test-project", undefined, "  dailyCap: 10000");
    await runStep({ store, dir, script: { usageTokens: 1500 } });
    const spent = store.getBudget("test", new Date().toISOString().slice(0, 10));
    expect(spent).toBe(1500); // one generator run (the evaluator Run is gone)
  });

  test("failed generator runs still count usage against the daily budget", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    const dir = await initLoopDir("test-project", undefined, "  dailyCap: 10000");
    await expect(
      runStep({ store, dir, script: { genStatus: "failed", usageTokens: 900 } }),
    ).rejects.toThrow();
    const spent = store.getBudget("test", new Date().toISOString().slice(0, 10));
    expect(spent).toBe(900); // tokens burned by the failed run are not free
  });

  test("workflow script carries repo path + git log context to the fix subagent", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    try {
      const store = createTestStore();
      stateWithFixingItem(store);
      const dir = await initLoopDir("test-project");
      const gitRunner: GitRunner = {
        revParse: () => Promise.resolve({ text: () => "abc123" }),
        diff: () => Promise.resolve({ text: () => "" }),
        resetHard: () => Promise.resolve({ text: () => "" }),
      };
      const { enqueues } = await runStep({
        store,
        dir,
        dataDir,
        projectPort,
        gitRunner,
        script: {},
      });
      const gen = enqueues.find((e) => e.agentMemberId.startsWith("loop-generator"))!;
      expect(gen.workflow?.script).toContain("Recent changes");
      expect(gen.workflow?.script).toContain('label: "fix"');
      expect(gen.workflow?.script).toContain('label: "verify"');
    } finally {
      await cleanup();
    }
  });

  test("taskClass drives the fix subagent guidance", async () => {
    const store = createTestStore();
    const state = loopReducer(emptyState(), {
      type: "ADD_ITEM",
      item: {
        id: "item-1",
        source: "issue",
        summary: "investigate flaky auth",
        taskClass: "research",
      },
      priority: 3,
    });
    store.save("test", state, {});
    const { enqueues } = await runStep({ store, script: {} });
    const gen = enqueues.find((e) => e.agentMemberId.startsWith("loop-generator"))!;
    expect(gen.workflow?.script).toContain("调研任务");
    expect(gen.workflow?.script).toContain("默认不改代码");
  });

  test("verifyCommands are rendered as mandatory steps in the verify subagent prompt", async () => {
    const { dataDir, projectPort, cleanup } = await setupGitDataDir();
    try {
      const store = createTestStore();
      stateWithFixingItem(store);
      const dir = await initLoopDir("test-project");
      await Bun.write(
        `${dir}/LOOP.md`,
        `---
projectId: test-project
model: gen-model
acceptance: "tests pass"
workflow:
  verifyCommands:
    - bun test
    - bun run typecheck
---
`,
      );
      const gitRunner: GitRunner = {
        revParse: () => Promise.resolve({ text: () => "abc123" }),
        diff: () => Promise.resolve({ text: () => "" }),
        resetHard: () => Promise.resolve({ text: () => "" }),
      };
      const { enqueues } = await runStep({
        store,
        dir,
        dataDir,
        projectPort,
        gitRunner,
        script: {},
      });
      const gen = enqueues.find((e) => e.agentMemberId.startsWith("loop-generator"))!;
      expect(gen.workflow?.script).toContain("bun test");
      expect(gen.workflow?.script).toContain("bun run typecheck");
      expect(gen.workflow?.script).toContain("No output for a command");
    } finally {
      await cleanup();
    }
  });
});

/** Commit a change on the bare fixture origin via a scratch worktree
 *  (the fixture source IS bare — you cannot commit inside it directly). */
async function commitOnOrigin(
  bareSrc: string,
  file: string,
  content: string,
  msg: string,
): Promise<void> {
  const scratch = `${bareSrc}-scratch`;
  await Bun.$`git -C ${bareSrc} worktree add -q ${scratch} main`.nothrow().quiet();
  try {
    await Bun.write(join(scratch, file), content);
    await Bun.$`git -C ${scratch} add -A`.quiet();
    await Bun.$`git -C ${scratch} -c user.email=t@t -c user.name=t commit -qm ${msg}`.quiet();
    await Bun.$`git -C ${scratch} push -q ${bareSrc} main:main`.nothrow().quiet();
  } finally {
    await Bun.$`git -C ${bareSrc} worktree remove --force ${scratch}`.nothrow().quiet();
  }
}

describe("loopCleanStart (A1): branch lifecycle", () => {
  test("PASS commit survives the next tick's clean start", async () => {
    const fixture = await setupGitDataDir();
    try {
      const store = createTestStore();
      stateWithFixingItem(store);
      const first = await runStep({
        store,
        dataDir: fixture.dataDir,
        projectPort: fixture.projectPort,
        // A real change so the PASS commit has content (meta alone is
        // deleted before the commit).
        script: { touchFiles: ["CHANGE.txt"] },
      });
      expect(first.result.items["item-1"]?.result?.verdict).toBe("PASS");
      // Second tick on the SAME fixture: the clean start must not wipe the
      // PASS commit (it resets to the branch's own HEAD, not the base).
      const second = await runStep({
        store,
        dataDir: fixture.dataDir,
        projectPort: fixture.projectPort,
      });
      const wtRoot = second.worktreeRoot;
      expect(existsSync(wtRoot)).toBe(true);
      const log = await Bun.$`git -C ${wtRoot} log --oneline -5`.quiet().text();
      expect(log).toMatch(/loop test item item-1/);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  test("branch strictly behind base fast-forwards to base", async () => {
    const dir = await setupGitDataDir();
    const agentWs = join(dir.dataDir, "loop-agent-ws");
    mkdirSync(join(agentWs, "projects"), { recursive: true });
    try {
      const { ensureMirror, ensureWorktree } = await import("../project/worktree.js");
      const repoUrl = dir.projectPort.getProject("test-project")!.repoUrl!;
      const mirror = await ensureMirror(dir.dataDir, {
        projectId: "test-project",
        repoUrl,
        defaultBranch: "main",
      });
      const wt = await ensureWorktree(
        mirror,
        agentWs,
        { projectId: "test-project", repoUrl, defaultBranch: "main" },
        "default",
      );
      if (!wt) throw new Error("worktree setup failed");
      // Base advances remotely; branch has nothing of its own.
      await commitOnOrigin(repoUrl, "NEW", "new", "new");
      await Bun.$`git -C ${mirror} fetch -q origin main:main`.nothrow().quiet();
      await loopCleanStart(wt, mirror, "main");
      const files = await Bun.$`git -C ${wt} ls-files`.quiet().text();
      expect(files).toContain("NEW");
    } finally {
      await dir.cleanup();
    }
  }, 20_000);

  test("diverged branch refuses instead of wiping ahead work", async () => {
    const dir = await setupGitDataDir();
    const agentWs = join(dir.dataDir, "loop-agent-ws");
    mkdirSync(join(agentWs, "projects"), { recursive: true });
    const { ensureMirror, ensureWorktree } = await import("../project/worktree.js");
    const mirror = await ensureMirror(dir.dataDir, {
      projectId: "test-project",
      repoUrl: dir.projectPort.getProject("test-project")!.repoUrl!,
      defaultBranch: "main",
    });
    const wt = await ensureWorktree(
      mirror,
      agentWs,
      { projectId: "test-project", repoUrl: "", defaultBranch: "main" },
      "default",
    );
    if (!wt) throw new Error("worktree setup failed");
    // agent commit + base advance -> divergence
    await Bun.$`echo mine > ${join(wt, "MINE")}`.quiet();
    await Bun.$`git -C ${wt} add -A`.quiet();
    await Bun.$`git -C ${wt} -c user.email=t@t -c user.name=t commit -qm mine`.quiet();
    const src = dir.projectPort.getProject("test-project")!.repoUrl!;
    await commitOnOrigin(src, "THEIRS", "theirs", "theirs");
    await Bun.$`git -C ${mirror} fetch -q origin main:main`.nothrow().quiet();
    await expect(loopCleanStart(wt, mirror, "main")).rejects.toThrow(/diverged/);
    // the ahead work is intact
    const mine = await Bun.$`git -C ${wt} log --oneline -1`.quiet().text();
    expect(mine).toContain("mine");
    await dir.cleanup();
  }, 20_000);
});

describe("verdictFromWorkflow shape guard", () => {
  test("malformed workflow output with no changes rejects", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    const { result } = await runStep({ store, script: { workflowVerdict: null } });
    expect(result.items["item-1"]!.result?.verdict).toBe("REJECT");
  });
});
