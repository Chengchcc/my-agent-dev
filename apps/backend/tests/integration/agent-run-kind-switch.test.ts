import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodingAgentBackend,
  type CodingAgentCommandConfig,
} from "@my-agent-team/adapter-coding-agent";
import { OmpBackend } from "@my-agent-team/adapter-omp-agent";
import type { Message } from "@my-agent-team/message";
import { buildAgentConfig } from "../../src/features/agent/agent-config.js";
import type { AgentRow } from "../../src/features/agent/domain.js";
import {
  createAgentContextService,
  sqliteAgentContextAdapter,
} from "../../src/features/agent-context/index.js";
import { sqliteAgentRunAdapter } from "../../src/features/agent-run/adapter-sqlite.js";
import { createAgentRunExecutionService } from "../../src/features/agent-run/execution.js";
import { createAgentRunService } from "../../src/features/agent-run/service.js";
import { sqliteConversationAdapter } from "../../src/features/conversation/adapter-sqlite.js";
import { createConversationFeature } from "../../src/features/conversation/conversation-compose.js";
import { openDb } from "../../src/infra/sqlite/db.js";
import { createRunTokenRegistry } from "../../src/features/product-tools/run-token-registry.js";

/** D2 acceptance: switching an agent's backend kind auto-forks a new
 *  default branch pinned to the new kind; the old branch's history stays
 *  intact. Run 1 goes through the real coding-agent child (scripted fake
 *  provider); run 2 goes through the omp adapter with the fake-CLI wire
 *  fixture. Both run to terminal via the real execution service. */

const CONV = "conv-switch";
const HUMAN = "human-1";
const AGENT_MEMBER = "agent-1";

const CODING_AGENT_ENTRY = new URL("../../../../apps/coding-agent/src/cli.ts", import.meta.url)
  .pathname;
const OMP_FAKE_ENTRY = new URL(
  "../../../../packages/adapter-omp-agent/src/__fixtures__/fake-omp.ts",
  import.meta.url,
).pathname;

let dataDir: string;
let db: ReturnType<typeof openDb>;
let convPort: ReturnType<typeof sqliteConversationAdapter>;
let contextPort: ReturnType<typeof sqliteAgentContextAdapter>;
let execution: ReturnType<typeof createAgentRunExecutionService>;
let feature: ReturnType<typeof createConversationFeature>;
let agentKind = "coding_agent";
/** branch the coding_agent run committed to (captured in test 1). */
let codingAgentBranchId = "";

// Stub agent row (file-first, ADR 0003): the conversation service reads
// the kind from agentModelRef(config.runtime_config).
function stubAgent(): AgentRow {
  return {
    id: "a1",
    workspacePath: "/tmp",
    config: buildAgentConfig({
      id: "a1",
      name: "Switch Agent",
      model: { provider: "fake", model: "echo" },
      backendKind: agentKind,
      permissionMode: "auto",
    }),
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  };
}

async function waitForTerminal(runId: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const rows = (await db
      .query("SELECT status FROM agent_run WHERE run_id = ?")
      .all(runId)) as Array<{ status: string }>;
    const status = rows[0]?.status;
    if (
      status === "completed" ||
      status === "failed" ||
      status === "aborted" ||
      status === "commit_failed"
    ) {
      return status;
    }
    await Bun.sleep(50);
  }
  throw new Error(`run ${runId} did not reach terminal`);
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "switch-e2e-"));
  db = openDb(`${dataDir}/backend.db`);
  convPort = sqliteConversationAdapter(db);
  contextPort = sqliteAgentContextAdapter(db, {
    ulid: () => `c-${Math.random().toString(36).slice(2, 8)}`,
  });
  const ledgerResolver = {
    async resolveMessage(cid: string, seq: number): Promise<Message | null> {
      const hit = convPort.getLedgerEntry(cid, seq);
      return hit ? (hit.content as never) : null;
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

  // coding_agent: real child (scripted fake provider); omp: fake-CLI.
  const codingAgentCommand: CodingAgentCommandConfig = {
    executable: process.execPath,
    args: [CODING_AGENT_ENTRY, "--mode", "rpc"],
    env: {
      CODING_AGENT_FAKE_PROVIDER: "1",
      CODING_AGENT_PRODUCT_TOOL_TOKEN: "t",
    },
  };
  const ompFake = new OmpBackend({
    executable: process.execPath,
    args: [OMP_FAKE_ENTRY],
    env: { OMP_FAKE_FIXTURE: "omp-wire-text.jsonl" },
  });

  execution = createAgentRunExecutionService({
    productToolsTokenRegistry: createRunTokenRegistry(),
    runPort,
    contextPort,
    ledgerResolver,
    backends: {
      coding_agent: {
        backend: new CodingAgentBackend(codingAgentCommand),
        // Stub catalog: the fake-provider child lists no real models, but
        // preflight needs the agent's model to exist (the switch path is
        // what this test exercises, not the catalog).
        catalog: {
          list: async () => ({
            models: [
              {
                id: "fake/echo",
                displayName: "Fake Echo",
                reasoning: false,
                inputModalities: ["text"],
                contextWindow: 128_000,
                maxOutputTokens: 8_192,
                available: true,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          }),
        },
      },
      omp: {
        backend: ompFake,
        catalog: {
          list: async () => ({
            models: [
              {
                id: "fake/echo",
                displayName: "Fake Echo",
                reasoning: false,
                inputModalities: ["text"],
                contextWindow: 128_000,
                maxOutputTokens: 8_192,
                available: true,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          }),
        },
      },
    },
    idGen: { ulid: () => `z-${Math.random().toString(36).slice(2, 8)}` },
    resolveWorkspace: async () => ({ root: dataDir, access: "read_write" }),
    productToolsEntrypoint: "stdio:/nonexistent",
  });

  feature = createConversationFeature({
    convPort,
    agentSvc: {
      getById: async () => stubAgent(),
    } as never,
    settingsSvc: { get: async () => 8 } as never,

    agentRunService,
    dispatchRun: (runId: string) => execution.dispatch(runId),
    injectSteer: (branchId, input) => execution.injectSteer(branchId, input),
    isLive: (runId) => execution.isLive(runId),
    isInflight: (runId) => execution.isInflight(runId),
    abortStaleRun: (runId) => execution.abortStaleRun(runId),
    contextService: contextSvc,
  });

  convPort.createConversation({ conversationId: CONV, createdAt: Date.now() });
  convPort.addMember({
    memberId: AGENT_MEMBER,
    conversationId: CONV,
    kind: "agent",
    agentId: "a1",
    joinedAt: Date.now(),
  });
  convPort.addMember({
    memberId: HUMAN,
    conversationId: CONV,
    kind: "human",
    displayName: "User",
    joinedAt: Date.now(),
  });
});

afterAll(async () => {
  await execution.dispose();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("backend kind switch auto-forks the branch (D2)", () => {
  test("run 1 lands on a coding_agent branch", async () => {
    const { triggeredRuns } = await feature.convSvc.postMessage({
      conversationId: CONV,
      senderMemberId: HUMAN,
      addressedTo: [AGENT_MEMBER],
      content: "first message",
    });
    expect(triggeredRuns.length).toBeGreaterThan(0);
    expect(await waitForTerminal(triggeredRuns[0]!.runId)).toBe("completed");
    const tree = await contextPort.getOrCreateTree(CONV, AGENT_MEMBER);
    const branch = await contextPort.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
    expect(branch.backendKind).toBe("coding_agent");
    codingAgentBranchId = branch.branchId;
  });

  test("kind switch to omp forks a new default branch; old history intact", async () => {
    agentKind = "omp";
    const { triggeredRuns } = await feature.convSvc.postMessage({
      conversationId: CONV,
      senderMemberId: HUMAN,
      addressedTo: [AGENT_MEMBER],
      content: "second message",
    });
    expect(triggeredRuns.length).toBeGreaterThan(0);
    await waitForTerminal(triggeredRuns[0]!.runId);

    const tree = await contextPort.getOrCreateTree(CONV, AGENT_MEMBER);
    const branch = await contextPort.getOrCreateDefaultBranch(tree.treeId, "omp");
    expect(branch.backendKind).toBe("omp");
    // the new default is a FORK: distinct branch id, old branch untouched
    expect(branch.branchId).not.toBe(codingAgentBranchId);

    // Old coding_agent branch still exists and keeps its kind.
    const rows = (await db
      .query(
        "SELECT branch_id, backend_kind, is_default FROM agent_context_branch WHERE tree_id = ?",
      )
      .all(tree.treeId)) as Array<{
      branch_id: string;
      backend_kind: string;
      is_default: number;
    }>;
    expect(rows.length).toBe(2);
    const old = rows.find((r) => r.backend_kind === "coding_agent");
    const fresh = rows.find((r) => r.backend_kind === "omp");
    expect(old).toBeDefined();
    expect(old?.is_default).toBe(0);
    expect(fresh?.is_default).toBe(1);

    // Run 2 completed through the omp adapter (fake fixture final "OK").
    const finalRun = (await db
      .query("SELECT run_id, branch_id FROM agent_run ORDER BY created_at DESC LIMIT 1")
      .get()) as { run_id: string; branch_id: string } | null;
    expect(finalRun?.branch_id).toBe(fresh?.branch_id);
  });
});
