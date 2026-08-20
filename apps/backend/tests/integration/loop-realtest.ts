/**
 * REAL-MODEL Loop end-to-end run (manual verification, not part of `bun test`):
 *   bun run apps/backend/tests/integration/loop-realtest.ts
 *
 * Uses the real DEEPSEEK_API_KEY: an oma child spawns with the real provider,
 * the fix subagent edits a buggy repo, the verify subagent runs `bun test`
 * against the acceptance criteria, and loopStep commits the PASS.
 *
 * Prereq: DEEPSEEK_API_KEY set. Slow (~1-5 min): real model calls.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OmaBackend,
  type OmaCommandConfig,
  OmaModelCatalog,
} from "@chengchenccc/adapter-oma-agent";
import { loopReducer } from "@chengchenccc/loop";
import {
  createAgentContextService,
  sqliteAgentContextAdapter,
} from "../../src/features/agent-context/index.js";
import { sqliteAgentRunAdapter } from "../../src/features/agent-run/adapter-sqlite.js";
import { createAgentRunExecutionService } from "../../src/features/agent-run/execution.js";
import { createAgentRunService } from "../../src/features/agent-run/service.js";
import { sqliteConversationAdapter } from "../../src/features/conversation/adapter-sqlite.js";
import { createLoopStateStore } from "../../src/features/loop/loop-state-store.js";
import { loopStep } from "../../src/features/loop/loop-step.js";
import { createRunTokenRegistry } from "../../src/features/product-tools/run-token-registry.js";
import { createWorkspaceLockRegistry } from "../../src/features/project/workspace-lock.js";
import { openDb } from "../../src/infra/sqlite/db.js";

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY is required for the real-model loop test");
  process.exit(2);
}

const OMA_ENTRY = new URL("../../../../apps/oh-my-agent/src/cli.ts", import.meta.url).pathname;
const LOOP_ID = "loop-realtest";
const ITEM_ID = "item-1";

const root = mkdtempSync(join(tmpdir(), "loop-realtest-"));
const dataDir = join(root, "data");
const loopDir = join(root, "loop");
mkdirSync(dataDir, { recursive: true });

// 1. A tiny real repo with a bug.
const src = join(root, "src");
mkdirSync(src, { recursive: true });
writeFileSync(
  join(src, "index.ts"),
  `export function add(a: number, b: number): number {
  return a - b; // BUG: should be a + b
}
`,
);
writeFileSync(
  join(src, "index.test.ts"),
  `import { expect, test } from "bun:test";
import { add } from "./index";
test("add", () => {
  expect(add(2, 3)).toBe(5);
});
`,
);
await Bun.$`git init -b main`.cwd(src).quiet();
await Bun.$`git config user.email t@t`.cwd(src).quiet();
await Bun.$`git config user.name t`.cwd(src).quiet();
await Bun.$`git add -A`.cwd(src).quiet();
await Bun.$`git commit -m init`.cwd(src).quiet();
const bare = join(root, "src.git");
await Bun.$`git init --bare ${bare}`.quiet();
await Bun.$`git -C ${src} remote add origin ${bare}`.quiet();
await Bun.$`git push origin main`.cwd(src).quiet();

// 2. Workflow-first LOOP.md with a mandatory verify command.
mkdirSync(loopDir, { recursive: true });
writeFileSync(
  join(loopDir, "LOOP.md"),
  `---
projectId: realtest
model: deepseek/deepseek-v4-flash
acceptance: "bun test 全绿"
workflow:
  verifyCommands:
    - bun test
---
`,
);

// 3. Backend assembly (same as the integration tests, no fake provider).
const db = openDb(`${dataDir}/backend.db`);
const convPort = sqliteConversationAdapter(db);
const contextPort = sqliteAgentContextAdapter(db, {
  ulid: () => `c-${Math.random().toString(36).slice(2, 8)}`,
});
const ledgerResolver = {
  async resolveMessage() {
    return null as never;
  },
};
const runPort = sqliteAgentRunAdapter(db, {
  contextPort,
  ledgerResolver,
  idGen: { ulid: () => `r-${Math.random().toString(36).slice(2, 8)}` },
});
const contextSvc = createAgentContextService({
  port: contextPort,
  idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
  ledgerResolver,
});
const agentRunService = createAgentRunService({
  port: runPort,
  contextService: contextSvc,
  idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
  ledgerResolver,
});
const command: OmaCommandConfig = {
  executable: process.execPath,
  args: [OMA_ENTRY, "--mode", "rpc"],
  env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY },
};
const execution = createAgentRunExecutionService({
  workspaceLocks: createWorkspaceLockRegistry(),
  productToolsTokenRegistry: createRunTokenRegistry(),
  runPort,
  contextPort,
  ledgerResolver,
  backends: {
    oma: {
      backend: new OmaBackend(command, { maxConcurrent: 1 }),
      catalog: new OmaModelCatalog(command),
    },
  },
  idGen: { ulid: () => `z-${Math.random().toString(36).slice(2, 8)}` },
  resolveWorkspace: async () => ({ root: dataDir, access: "read_write" }),
  productToolsEntrypoint: "stdio:/nonexistent",
});

const store = createLoopStateStore(db);
const state = loopReducer(
  { loopId: LOOP_ID, lastRun: null, items: {} },
  {
    type: "ADD_ITEM",
    item: {
      id: ITEM_ID,
      source: "manual",
      summary: "修复 add 函数:2+3 应等于 5",
      taskClass: "bugfix",
    },
    priority: 3,
  },
);
store.save(LOOP_ID, state, {});

const projectPort = {
  getProject: (id: string) =>
    id === "realtest"
      ? {
          projectId: "realtest",
          name: "t",
          repoUrl: bare,
          defaultBranch: "main",
          createdAt: 0,
          updatedAt: 0,
        }
      : null,
} as never;

console.log("=== running loopStep with REAL deepseek model (may take minutes) ===");
const t0 = Date.now();
const result = await loopStep({
  loopConfigPath: loopDir,
  store,
  loopId: LOOP_ID,
  convPort,
  projectPort,
  dataDir,
  agentRunService,
  agentRunExecution: execution,
  resolveModel: async (modelId) => ({ backendKind: "oma", modelId }),
  agentWorkspaceOf: async () => join(dataDir, "loop-agent-ws"),
  withWorkspaceLock: createWorkspaceLockRegistry().withLock.bind(createWorkspaceLockRegistry()),
});
console.log(`=== loopStep finished in ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);

const item = result.items[ITEM_ID];
console.log("item.step:", item.step);
console.log("item.result:", JSON.stringify(item.result, null, 2));

// 4. Assertions.
const clone = join(dataDir, "loop-agent-ws", "projects", "realtest");
const fixed = existsSync(join(clone, "index.ts"))
  ? await Bun.file(join(clone, "index.ts")).text()
  : "";
const ok = item.result?.verdict === "PASS" && fixed.includes("return a + b");
const log = existsSync(clone)
  ? await Bun.$`git -C ${clone} log --oneline -3`.nothrow().quiet().text()
  : "";
console.log("--- repo state ---");
console.log(fixed);
console.log(log);

db.close();
rmSync(root, { recursive: true, force: true });
console.log(ok ? "\n✅ REAL LOOP PASSED" : "\n❌ REAL LOOP FAILED");
process.exit(ok ? 0 : 1);
