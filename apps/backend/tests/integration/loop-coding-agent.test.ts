import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodingAgentBackend,
  type CodingAgentCommandConfig,
  CodingAgentModelCatalog,
} from "@my-agent-team/adapter-coding-agent";
import type { BackendEvent } from "@my-agent-team/agent-backend";
import type { LoopState } from "@my-agent-team/loop";
import { loopReducer } from "@my-agent-team/loop";
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
import { openDb } from "../../src/infra/sqlite/db.js";

/** THE real Loop chain: loopStep → AgentRunService → AgentRunExecution →
 *  real coding-agent child (--mode rpc, fake provider) → git mutations in
 *  the cloned repo → the workflow meta writeback (reducer-validated) →
 *  reducer transition. Skills come from <loopConfigPath>/skills and are
 *  loaded by the real child (skill_load tool result observed in events).
 *
 *  Deterministic: the fake provider's scripted tool calls drive real bash
 *  tool execution in the clone - no remote model. */

const CODING_AGENT_ENTRY = new URL("../../../../apps/coding-agent/src/cli.ts", import.meta.url)
  .pathname;

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
const eventLog = new Map<string, BackendEvent<"coding_agent">[]>();

/** The scripted tool script: ONE branch for both roles, decided by the
 *  workspace state:
 *  - generator (changes.txt missing): commit a change to the clone;
 *  - verifier (changes.txt present): write the workflow meta verdict.
 *  The second entry proves the real child loaded <loopConfigPath>/skills:
 *  skill_load must resolve the loop-skill body (visible in events). */
const LOOP_META_JSON = JSON.stringify({
  items: {
    [ITEM_ID]: {
      id: ITEM_ID,
      step: "verifying",
      result: { verdict: "PASS", evidence: "loop-e2e" },
    },
  },
});
const FAKE_TOOL_SCRIPT = JSON.stringify([
  {
    name: "bash",
    input: {
      command:
        "echo phase5 >> changes.txt && git add -A && git -c user.name=loop -c user.email=loop@test commit -m phase5-change",
    },
  },
  { name: "skill_load", input: { name: "loop-skill" } },
  {
    name: "bash",
    input: {
      command: `cat > .workflows/loop.js <<'WFE'
export const meta = ${LOOP_META_JSON};
WFE`,
    },
  },
]);

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
  // Distinct models are REQUIRED by parseLoopConfig; both exist in the fake
  // provider catalog.
  writeFileSync(
    join(loopDir, "LOOP.md"),
    `---
projectId: test-project
generator:
  model: fake/echo
  systemPrompt: "Fix the item. Commit your changes."
evaluator:
  model: fake/echo2
  systemPrompt: "Review the diff and write VERDICT.md."
acceptance: "the change is committed"
denylist:
  - secrets/**
---
`,
  );
  // The skills dir the child must load: skillRoots = <loopConfigPath>/skills.
  mkdirSync(join(loopDir, "skills", "loop-skill"), { recursive: true });
  writeFileSync(
    join(loopDir, "skills", "loop-skill", "SKILL.md"),
    "---\nname: loop-skill\ndescription: Loop integration test skill\n---\n\nLOOP SKILL BODY MARKER\n",
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

  const codingAgentCommand: CodingAgentCommandConfig = {
    executable: process.execPath,
    args: [CODING_AGENT_ENTRY, "--mode", "rpc"],
    env: {
      CODING_AGENT_FAKE_PROVIDER: "1",
      CODING_AGENT_FAKE_TOOL: FAKE_TOOL_SCRIPT,
    },
  };
  const realExecution = createAgentRunExecutionService({
    productToolsTokenRegistry: createRunTokenRegistry(),
    runPort,
    contextPort,
    ledgerResolver,
    backends: {
      coding_agent: {
        backend: new CodingAgentBackend(codingAgentCommand, { maxConcurrent: 1 }),
        catalog: new CodingAgentModelCatalog(codingAgentCommand),
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
      const events: BackendEvent<"coding_agent">[] = [];
      const sub = realExecution.subscribe(runId);
      const collector = (async () => {
        for await (const ev of sub) events.push(ev as BackendEvent<"coding_agent">);
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

describe("Loop with a REAL coding-agent child", () => {
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
        backendKind: "coding_agent",
        modelId,
      }),
      agentWorkspaceOf: async () => join(dataDir, "loop-agent-ws"),
    });

    // ── State machine: generator + evaluator ran, verdict PASS ──
    const item = result.items[ITEM_ID]!;

    expect(item.generatorRunId).toBeTruthy();
    expect(item.evaluatorRunId).toBeFalsy();
    expect(item.result?.verdict).toBe("PASS");

    // ── The generator REALLY modified the worktree; on PASS the product
    //    layer commits everything onto the agent branch (H2) ──
    const clone = join(dataDir, "loop-agent-ws", "projects", "test-project");
    const log = await Bun.$`git -C ${clone} log --oneline -3`.quiet().text();
    expect(log).toContain("phase5-change");
    expect(log).toContain("loop loop-e2e item item-1");
    const diff = await Bun.$`git -C ${clone} diff HEAD~2..HEAD --name-only`.quiet().text();
    expect(diff).toContain("changes.txt");

    // H2: the PASS commit landed on the agent branch — the mirror's base
    // is now behind it (aggregate-page FF becomes available).
    const branch = await Bun.$`git -C ${clone} rev-parse --abbrev-ref HEAD`.quiet().text();
    expect(branch.trim()).toMatch(/^agent\//);

    // ── The workflow meta really landed in the clone ──
    const metaScript = await Bun.file(join(clone, ".workflows", "loop.js")).text();
    expect(metaScript).toContain('"verdict":"PASS"');

    // ── The real child loaded <loopConfigPath>/skills: skill_load
    //    resolved the loop-skill body (observable in the run events) ──
    const genEvents = eventLog.get(item.generatorRunId!) ?? [];
    const skillLoad = genEvents.find(
      (e) =>
        e.type === "native_tool_completed" &&
        (e as { toolName?: string }).toolName === "skill_load",
    );
    expect(skillLoad).toBeDefined();
    const body = (skillLoad as { result?: { body?: string } }).result?.body ?? "";
    expect(body).toContain("LOOP SKILL BODY MARKER");

    // ── The bash commit went through the real child's native tool ──
    expect(
      genEvents.some(
        (e) =>
          e.type === "native_tool_completed" && (e as { toolName?: string }).toolName === "bash",
      ),
    ).toBe(true);
  }, 60_000);
});
