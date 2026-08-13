import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRunOutcome } from "@my-agent-team/agent-backend";
import type { LoopState } from "@my-agent-team/loop";
import { loopReducer } from "@my-agent-team/loop";
import type { AgentRun } from "../agent-run/domain.js";
import type { AgentRunExecutionService } from "../agent-run/execution.js";
import type { AgentRunService } from "../agent-run/service.js";
import type { ProjectRow } from "../project/domain.js";
import type { ProjectPort } from "../project/ports.js";
import { createLoopStateStore, type LoopStateStore } from "./loop-state-store.js";
import type { GitRunner } from "./loop-step.js";
import { loopStep } from "./loop-step.js";

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
generator:
  model: gen-model
evaluator:
  model: eval-model
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
        autoOrchestrate: false,
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
  evalStatus?: "completed" | "aborted" | "timeout";
  /** VERDICT.md content the evaluator "writes". */
  evalVerdictMd?: string;
  /** usage tokens returned on both runs. */
  usageTokens?: number;
  /** generator rejects the input (queued behind another run). */
  genQueued?: boolean;
  /** first generator enqueue REPLAYS a terminal failed run; the retry-scoped
   *  key must then acquire a FRESH run. */
  genReplayTerminal?: boolean;
}

function makeFakeRuns(script: RunScript, workDir: string = "") {
  const enqueues: Array<{
    conversationId: string;
    agentMemberId: string;
    mode: string;
    idempotencyKey: string;
    message: { text?: string };
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
      modelRef: { backendKind: "coding_agent", modelId: "m" },
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
      });
      if (script.genQueued && input.agentMemberId.startsWith("loop-generator")) {
        return { acquired: false, queued: true, replayed: false, inputId: "in" };
      }
      if (
        script.genReplayTerminal &&
        input.agentMemberId.startsWith("loop-generator") &&
        !input.idempotencyKey.endsWith(":retry")
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
    async hasActiveRunForConversations() {
      return false;
    },
  };

  const agentRunExecution: AgentRunExecutionService = {
    async dispatch(runId) {
      const run = runs.get(runId);
      if (!run) return;
      if (run.agentMemberId.startsWith("loop-evaluator")) {
        const status = script.evalStatus ?? "completed";
        (run as { status: AgentRun["status"] }).status = status;
        if (script.evalVerdictMd !== undefined) {
          await Bun.write(`${workDir}/VERDICT.md`, script.evalVerdictMd);
        }
        (run as { terminalResult: BackendRunOutcome | null }).terminalResult = {
          status: status === "completed" ? "completed" : status,
          ...(script.usageTokens !== undefined
            ? { usage: { inputTokens: script.usageTokens, outputTokens: 0 } }
            : {}),
        } as BackendRunOutcome;
      } else {
        const status = script.genStatus ?? "completed";
        (run as { status: AgentRun["status"] }).status = status;
        (run as { terminalResult: BackendRunOutcome | null }).terminalResult = {
          status: status === "completed" ? "completed" : status,
          ...(script.usageTokens !== undefined
            ? { usage: { inputTokens: script.usageTokens, outputTokens: 0 } }
            : {}),
        } as BackendRunOutcome;
      }
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
const evalConversationId = (loopId: string) => `loop:${loopId}:evaluator`;

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
  const fake = makeFakeRuns(overrides.script ?? {}, `${dataDir}/repos/test-project`);
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
      resolveModel: async (name) => ({ backendKind: "coding_agent", modelId: name }),
    });
    return { result, ...fake };
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
  test("TICK → generator + evaluator each run on their own stable scope", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    const { enqueues } = await runStep({
      store,
      script: { evalVerdictMd: "verdict: PASS\nevidence: ok" },
    });

    const gen = enqueues.find((e) => e.agentMemberId.startsWith("loop-generator"));
    const eva = enqueues.find((e) => e.agentMemberId.startsWith("loop-evaluator"));
    expect(gen).toBeTruthy();
    expect(eva).toBeTruthy();
    // independent deterministic identities
    expect(gen!.conversationId).toBe(genConversationId("test"));
    expect(eva!.conversationId).toBe(evalConversationId("test"));
    expect(gen!.conversationId).not.toBe(eva!.conversationId);
    expect(gen!.mode).toBe("normal");
    expect(gen!.idempotencyKey).toContain("loop-gen:test:item-1:");
  });

  test("PASS verdict → item resolved; generatorRunId + evaluatorRunId persisted", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    const { enqueues } = await runStep({
      store,
      script: { evalVerdictMd: "verdict: PASS\nevidence: tests green" },
    });
    const gen = enqueues.find((e) => e.agentMemberId.startsWith("loop-generator"))!;
    const eva = enqueues.find((e) => e.agentMemberId.startsWith("loop-evaluator"))!;

    const saved = store.load("test");
    const item = Object.values(saved.items)[0]!;
    expect(item.step).toBe("awaiting_review");
    // generatorRunId field now carries the Agent Run id
    expect(item.generatorRunId).toMatch(/^run-\d+$/);
    expect(item.evaluatorRunId).toMatch(/^run-\d+$/);
    expect(item.evaluatorRunId).not.toBe(item.generatorRunId);
    expect(item.result?.verdict).toBe("PASS");
    void gen;
    void eva;
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
        const fake = makeFakeRuns({ genStatus: "failed" }, `${dataDir}/repos/test-project`);
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
            resolveModel: async (name) => ({ backendKind: "coding_agent", modelId: name }),
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
      script: {
        genReplayTerminal: true,
        evalVerdictMd: "verdict: PASS\nevidence: e",
      },
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
      script: { evalVerdictMd: "verdict: REJECT\nreason: not good\nevidence: e" },
    });
    const item = result.items["item-1"]!;
    expect(item.step).toBe("fixing");
    expect(item.attempt).toBe(2);
  });

  test("denylist violation → REJECT without evaluator run", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    const dir = await initLoopDir("test-project", "        - .env");
    const gitRunner: GitRunner = {
      revParse: () => Promise.resolve({ text: () => "deadbeef" }),
      diff: () => Promise.resolve({ text: () => ".env\n" }),
      resetHard: () => Promise.resolve({ text: () => "" }),
    };
    const { enqueues, result } = await runStep({ store, dir, gitRunner });
    expect(enqueues.some((e) => e.agentMemberId.startsWith("loop-evaluator"))).toBe(false);
    expect(result.items["item-1"]!.result?.verdict).toBe("REJECT");
  });

  test("empty VERDICT.md → ESCALATE to inbox", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    const { result } = await runStep({ store, script: { evalVerdictMd: "" } });
    const item = result.items["item-1"]!;
    expect(item.step).toBe("inbox");
    expect(item.result?.verdict).toBe("ESCALATE");
  });

  test("evaluator timeout (aborted) → no crash, ESCALATE on empty verdict", async () => {
    const store = createTestStore();
    stateWithFixingItem(store);
    const { result } = await runStep({
      store,
      script: { evalStatus: "aborted", evalVerdictMd: "" },
    });
    const item = result.items["item-1"]!;
    expect(item.step).toBe("inbox");
    expect(item.result?.verdict).toBe("ESCALATE");
    expect(item.evaluatorRunId).toBeTruthy();
  });

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
    await runStep({
      store,
      dir,
      script: { evalVerdictMd: "verdict: PASS\nevidence: e", usageTokens: 1500 },
    });
    const spent = store.getBudget("test", new Date().toISOString().slice(0, 10));
    expect(spent).toBe(3000); // gen + eval
  });

  test("generator prompt includes repo path + git log context", async () => {
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
        script: { evalVerdictMd: "verdict: PASS\nevidence: e" },
      });
      const gen = enqueues.find((e) => e.agentMemberId.startsWith("loop-generator"))!;
      expect(gen.message.text).toContain(`${dataDir}/repos/test-project`);
      expect(gen.message.text).toContain("Project Context");
      expect(gen.message.text).toContain("Recent changes");
    } finally {
      await cleanup();
    }
  });
});
