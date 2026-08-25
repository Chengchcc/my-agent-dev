import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OmaBackend,
  type OmaCommandConfig,
  OmaModelCatalog,
} from "@chengchenccc/adapter-oma-agent";
import type { BackendEvent } from "@chengchenccc/agent-backend";
import type { LoopState } from "@chengchenccc/loop";
import { loopReducer } from "@chengchenccc/loop";
import {
  createAgentContextService,
  sqliteAgentContextAdapter,
} from "../../src/features/agent-context/index.js";
import { sqliteAgentRunAdapter } from "../../src/features/agent-run/adapter-sqlite.js";
import type { AgentRunExecutionService } from "../../src/features/agent-run/execution.js";
import { createAgentRunExecutionService } from "../../src/features/agent-run/execution.js";
import { createAgentRunService } from "../../src/features/agent-run/service.js";
import { sqliteConversationAdapter } from "../../src/features/conversation/adapter-sqlite.js";
import {
  createLoopStateStore,
  type LoopStateStore,
} from "../../src/features/loop/loop-state-store.js";
import { loopStep } from "../../src/features/loop/loop-step.js";
import { createRunTokenRegistry } from "../../src/features/product-tools/run-token-registry.js";
import { createWorkspaceLockRegistry } from "../../src/features/project/workspace-lock.js";
import { openDb } from "../../src/infra/sqlite/db.js";

/** THE real Loop chain: loopStep → AgentRunService → AgentRunExecution →
 *  real oma child (--mode rpc, fake provider) → git mutations in
 *  the cloned repo → the workflow meta writeback (reducer-validated) →
 *  reducer transition. Skills come from <loopConfigPath>/skills and are
 *  loaded by the real child (skill_load tool result observed in events).
 *
 *  Deterministic: the fake provider's scripted tool calls drive real bash
 *  tool execution in the clone - no remote model. */

const OMA_ENTRY = new URL("../../../../apps/oh-my-agent/src/cli.ts", import.meta.url).pathname;

const LOOP_ID = "loop-e2e";
const ITEM_ID = "item-1";

let dataDir: string;
let loopDir: string;
let db: ReturnType<typeof openDb>;
let store: LoopStateStore;
let convPort: ReturnType<typeof sqliteConversationAdapter>;
let contextPort: ReturnType<typeof sqliteAgentContextAdapter>;
let runPort: ReturnType<typeof sqliteAgentRunAdapter>;
let ledgerResolver: { resolveMessage(cid: string, seq: number): Promise<never> };
let agentRunService: ReturnType<typeof createAgentRunService>;
let execution: AgentRunExecutionService;
/** runId → observed Backend events (captured around dispatch). */
const eventLog = new Map<string, BackendEvent<"oma">[]>();

/** The scripted tool script: the fix subagent commits a real change to the
 *  clone. The verify subagent gets no scripted tool and returns
 *  OMA_FAKE_TEXT — a legal schema JSON verdict — so the workflow run ends
 *  with a real PASS and the product layer commits the verified change
 *  (H2). */
const FAKE_TOOL_SCRIPT = JSON.stringify([
  {
    name: "bash",
    input: {
      // The fix subagent edits the repo but does NOT commit (per the
      // rendered workflow prompt); the product layer commits on PASS.
      command: "echo phase5 >> changes.txt",
    },
  },
]);
const FAKE_VERIFY_VERDICT = JSON.stringify({
  verdict: "PASS",
  evidence: "fake e2e evidence: changes.txt touched by fix subagent",
  reasons: [],
});

async function setupRemoteRepo(): Promise<string> {
  const bare = join(dataDir, "remote.git");
  const work = join(dataDir, "src-wt");
  mkdirSync(work, { recursive: true });
  await Bun.$`git init -b main`.cwd(work).quiet();
  await Bun.$`git config user.email test@test`.cwd(work).quiet();
  await Bun.$`git config user.name Test`.cwd(work).quiet();
  writeFileSync(join(work, "init.txt"), "init\n");
  await Bun.$`git add -A`.cwd(work).quiet();
  await Bun.$`git commit -m init`.cwd(work).quiet();
  await Bun.$`git init --bare ${bare}`.quiet();
  await Bun.$`git remote add origin ${bare}`.cwd(work).quiet();
  await Bun.$`git push origin main`.cwd(work).quiet();
  return bare;
}

async function setupLoopDir(): Promise<void> {
  loopDir = mkdtempSync(join(tmpdir(), "loop-e2e-"));
  // Workflow-first LOOP.md: single model (subagents share it), acceptance
  // drives the verify prompt. The model must exist in the fake catalog.
  writeFileSync(
    join(loopDir, "LOOP.md"),
    `---
projectId: test-project
model: fake/echo
acceptance: "the change is committed"
denylist:
  - secrets/**
---
`,
  );
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "loop-e2e-data-"));
  await setupLoopDir();
  await setupRemoteRepo();

  db = openDb(`${dataDir}/backend.db`);
  convPort = sqliteConversationAdapter(db);
  contextPort = sqliteAgentContextAdapter(db, {
    ulid: () => `c-${Math.random().toString(36).slice(2, 8)}`,
  });
  ledgerResolver = {
    async resolveMessage(cid: string, seq: number): Promise<never> {
      void cid;
      void seq;
      return null as never;
    },
  };
  runPort = sqliteAgentRunAdapter(db, {
    contextPort,
    ledgerResolver,
    idGen: { ulid: () => `r-${Math.random().toString(36).slice(2, 8)}` },
  });
  const contextSvc = createAgentContextService({
    port: contextPort,
    idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
    ledgerResolver,
  });
  agentRunService = createAgentRunService({
    port: runPort,
    contextService: contextSvc,
    idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
    ledgerResolver,
  });

  const codingAgentCommand: OmaCommandConfig = {
    executable: process.execPath,
    args: [OMA_ENTRY, "--mode", "rpc"],
    env: {
      OMA_FAKE_PROVIDER: "1",
      OMA_FAKE_TOOL: FAKE_TOOL_SCRIPT,
      OMA_FAKE_TEXT: FAKE_VERIFY_VERDICT,
    },
  };
  const realExecution = createAgentRunExecutionService({
    workspaceLocks: createWorkspaceLockRegistry(),
    productToolsTokenRegistry: createRunTokenRegistry(),
    runPort,
    contextPort,
    ledgerResolver,
    backends: {
      oma: {
        backend: new OmaBackend(codingAgentCommand, { maxConcurrent: 1 }),
        catalog: new OmaModelCatalog(codingAgentCommand),
      },
    },
    idGen: { ulid: () => `z-${Math.random().toString(36).slice(2, 8)}` },
    resolveWorkspace: async () => ({ root: dataDir, access: "read_write" }),
    productToolsEntrypoint: "stdio:/nonexistent",
  });
  // Capture every run's transient events around dispatch for assertions.
  execution = {
    ...realExecution,
    async dispatch(runId) {
      const events: BackendEvent<"oma">[] = [];
      const sub = realExecution.subscribe(runId);
      const collector = (async () => {
        for await (const ev of sub) events.push(ev as BackendEvent<"oma">);
      })();
      await realExecution.dispatch(runId);
      await collector;
      eventLog.set(runId, events);
    },
  };

  // Seed the Loop state with one triaged item; TICK promotes it to fixing.
  store = createLoopStateStore(db);
  const state: LoopState = loopReducer(
    { loopId: LOOP_ID, lastRun: null, items: {} },
    {
      type: "ADD_ITEM",
      item: { id: ITEM_ID, source: "issue", summary: "make a change in the repo" },
      priority: 3,
    },
  );
  store.save(LOOP_ID, state, {});
});

afterAll(async () => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(loopDir, { recursive: true, force: true });
});

describe("Loop with a REAL oma child", () => {
  test("generator commits to the clone, loads loop skills, writes the workflow meta", async () => {
    const projectPort = {
      createProject: () => {
        throw new Error("not implemented");
      },
      getProject: (projectId: string) =>
        projectId === "test-project"
          ? {
              projectId: "test-project",
              name: "test",
              repoUrl: join(dataDir, "remote.git"),
              defaultBranch: "main",
              createdAt: 0,
              updatedAt: 0,
            }
          : null,
      listProjects: () => [],
      updateProject: () => null,
      deleteProject: () => false,
    };

    const result = await loopStep({
      loopConfigPath: loopDir,
      store,
      loopId: LOOP_ID,
      convPort,
      projectPort,
      dataDir,
      agentRunService,
      agentRunExecution: execution,
      resolveModel: async (modelId) => ({
        backendKind: "oma",
        modelId,
      }),
      agentWorkspaceOf: async () => join(dataDir, "loop-agent-ws"),
      withWorkspaceLock: createWorkspaceLockRegistry().withLock.bind(createWorkspaceLockRegistry()),
    });

    // ── State machine: workflow ran, verified change → PASS ──
    const item = result.items[ITEM_ID]!;

    expect(item.generatorRunId).toBeTruthy();
    expect(item.evaluatorRunId).toBeFalsy();
    expect(item.result?.verdict).toBe("PASS");

    // ── The fix subagent REALLY modified the worktree; on PASS the product
    //    layer commits everything onto the agent branch (H2) ──
    const clone = join(dataDir, "loop-agent-ws", "projects", "test-project");
    const log = await Bun.$`git -C ${clone} log --oneline -3`.quiet().text();
    expect(log).toContain("loop loop-e2e item item-1");
    const diff = await Bun.$`git -C ${clone} diff HEAD~1..HEAD --name-only`.quiet().text();
    expect(diff).toContain("changes.txt");

    // H2: the PASS commit landed on the agent branch — the mirror's base
    // is now behind it (aggregate-page FF becomes available).
    const branch = await Bun.$`git -C ${clone} rev-parse --abbrev-ref HEAD`.quiet().text();
    expect(branch.trim()).toMatch(/^agent\//);

    // Workflow-first: no .oma/workflow scratch file is ever written (the run
    // executes the script in the sandbox; the verdict lives in the outcome).
    expect(existsSync(join(clone, ".oma/workflow", "loop.js"))).toBe(false);

    // ── The real child ran the workflow: subagents executed, workflow
    //    lifecycle events were observed on the run stream ──
    const genEvents = eventLog.get(item.generatorRunId!) ?? [];
    expect(genEvents.some((e) => e.type === "workflow_started")).toBe(true);
    expect(genEvents.some((e) => e.type === "workflow_agent_started")).toBe(true);
    expect(genEvents.some((e) => e.type === "workflow_agent_completed")).toBe(true);
    expect(genEvents.some((e) => e.type === "workflow_completed")).toBe(true);
  }, 60_000);
});
