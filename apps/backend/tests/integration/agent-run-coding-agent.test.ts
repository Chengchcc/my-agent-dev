import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodingAgentBackend,
  type CodingAgentCommandConfig,
  CodingAgentModelCatalog,
} from "@my-agent-team/adapter-coding-agent";
import type { Message } from "@my-agent-team/message";
import { assistantMessageId, parseMessageRevision } from "@my-agent-team/message";
import {
  createAgentContextService,
  projectAgentContext,
  sqliteAgentContextAdapter,
} from "../../src/features/agent-context/index.js";
import { sqliteAgentRunAdapter } from "../../src/features/agent-run/adapter-sqlite.js";
import { createAgentRunExecutionService } from "../../src/features/agent-run/execution.js";
import { createAgentRunService } from "../../src/features/agent-run/service.js";
import { sqliteConversationAdapter } from "../../src/features/conversation/adapter-sqlite.js";
import { sqliteProductToolCallAdapter } from "../../src/features/product-tools/adapter-sqlite.js";
import { buildHistoryTools } from "../../src/features/product-tools/manifest.js";
import { createProductToolsMcpServer } from "../../src/features/product-tools/mcp.js";
import { createProductToolsService } from "../../src/features/product-tools/service.js";
import { openDb } from "../../src/infra/sqlite/db.js";

/** THE Phase 5 acceptance chain, all real:
 *
 *  Product Backend (this process)
 *    → CodingAgentBackend (adapter) spawns a REAL child process
 *    → apps/coding-agent/src/cli.ts --mode rpc (stdin/stdout JSONL)
 *    → per-Run Coding Agent Runtime (fresh in-memory store, no Worker,
 *      no session, no HTTP)
 *    → real CodingAgentSession with the scripted fake provider
 *    → production resolveTools → real Product Tools MCP (SSE + Bearer token)
 *    → BackendRunOutcome
 *    → backend.db terminal commit (ledger + context + branch + run)
 *
 *  No fake/in-process Backend anywhere in the chain. */

const TOKEN = "product-tools-token";
const CONV = "conv-e2e";
const MEMBER = "mem-e2e";

const CODING_AGENT_ENTRY = new URL("../../../../apps/coding-agent/src/cli.ts", import.meta.url)
  .pathname;

let dataDir: string;
let db: ReturnType<typeof openDb>;
let convPort: ReturnType<typeof sqliteConversationAdapter>;
let contextPort: ReturnType<typeof sqliteAgentContextAdapter>;
let runPort: ReturnType<typeof sqliteAgentRunAdapter>;
let ledgerResolver: { resolveMessage(cid: string, seq: number): Promise<Message | null> };
let backend: ReturnType<typeof createAgentRunService>;
let execution: ReturnType<typeof createAgentRunExecutionService>;
let mcp: Awaited<ReturnType<typeof createProductToolsMcpServer>>;
let branchId: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "phase5-e2e-"));
  db = openDb(`${dataDir}/backend.db`);
  convPort = sqliteConversationAdapter(db);
  contextPort = sqliteAgentContextAdapter(db, {
    ulid: () => `c-${Math.random().toString(36).slice(2, 8)}`,
  });
  ledgerResolver = {
    async resolveMessage(cid: string, seq: number) {
      const hit = convPort.getLedgerEntry(cid, seq);
      return hit ? (hit.content as never) : null;
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
  backend = createAgentRunService({
    port: runPort,
    contextService: contextSvc,
    idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
    ledgerResolver,
  });

  // Real Product Tools MCP server (this process).
  const productTools = createProductToolsService({
    runPort,
    contextPort,
    conversationPort: convPort,
    callPort: sqliteProductToolCallAdapter(db),
    idGen: { ulid: () => `y-${Math.random().toString(36).slice(2, 8)}` },
  });
  mcp = await createProductToolsMcpServer({ service: productTools, serviceToken: TOKEN });

  // Real Coding Agent as a SEPARATE PROCESS per Run (deployment-shaped):
  // the adapter spawns `bun apps/coding-agent/src/cli.ts --mode rpc` and
  // speaks stdin/stdout JSONL. cwd = the Run workspace; the Product Tools
  // service token reaches the child ONLY through the process env.
  const ws = mkdtempSync(join(tmpdir(), "phase5-ws-"));
  // ADR 0003 decision 6: the child builds its tool table from the cwd
  // manifest (.agent/product-tools.json) written by the workspace bridge;
  // seed it directly here — no bridge runs in this harness.
  mkdirSync(join(ws, ".agent"), { recursive: true });
  writeFileSync(
    join(ws, ".agent", "product-tools.json"),
    JSON.stringify(buildHistoryTools(`sse:${mcp.url}`)),
  );
  const codingAgentCommand: CodingAgentCommandConfig = {
    executable: process.execPath,
    args: [CODING_AGENT_ENTRY, "--mode", "rpc"],
    env: {
      CODING_AGENT_FAKE_PROVIDER: "1",
      // the child's model calls history_recent ONCE, then produces text
      CODING_AGENT_FAKE_TOOL: JSON.stringify([{ name: "history_recent", input: { limit: 5 } }]),
      // bound a hanging MCP call so a stuck tool fails fast and the run
      // still completes (tool error -> model fallback text)
      CODING_AGENT_PRODUCT_TOOL_TIMEOUT_MS: "2000",
      // service token the child attaches to its Product Tools MCP transport
      CODING_AGENT_PRODUCT_TOOL_TOKEN: TOKEN,
    },
  };
  execution = createAgentRunExecutionService({
    runPort,
    contextPort,
    ledgerResolver,
    backends: {
      coding_agent: {
        backend: new CodingAgentBackend(codingAgentCommand),
        catalog: new CodingAgentModelCatalog(codingAgentCommand),
      },
    },
    idGen: { ulid: () => `z-${Math.random().toString(36).slice(2, 8)}` },
    resolveWorkspace: async () => ({ root: ws, access: "read_write" }),
    productToolsEntrypoint: `sse:${mcp.url}`,
  });

  convPort.createConversation({ conversationId: CONV, createdAt: Date.now() });
  convPort.addMember({
    memberId: MEMBER,
    conversationId: CONV,
    kind: "agent",
    agentId: "a1",
    joinedAt: Date.now(),
  });
  const tree = await contextPort.getOrCreateTree(CONV, MEMBER);
  const branch = await contextPort.getOrCreateDefaultBranch(tree.treeId, "coding_agent");
  branchId = branch.branchId;
});

afterAll(async () => {
  await mcp.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function waitForTerminal(runId: string): Promise<Awaited<ReturnType<typeof runPort.getRun>>> {
  for (let i = 0; i < 200; i++) {
    const run = await runPort.getRun(runId);
    if (run && run.status !== "running" && run.status !== "waiting") return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} never reached terminal`);
}

describe("Phase 5 acceptance: Product Backend -> Coding Agent child -> Product Tools MCP", () => {
  test("a dispatched run completes end to end and commits exactly once", async () => {
    // seed a conversation message the child's history_recent call will read
    convPort.appendLedgerEntry({
      conversationId: CONV,
      senderMemberId: "human-1",
      kind: "message",
      content: JSON.stringify({ role: "user", text: "seed question" }),
      ts: Date.now(),
    });

    const acquired = await backend.enqueueAndAcquire({
      conversationId: CONV,
      agentMemberId: MEMBER,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "run this" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "e2e-run-1",
    });
    expect(acquired.acquired).toBe(true);
    const runId = acquired.run!.runId;

    const events: string[] = [];
    const sub = execution.subscribe(runId);
    const collector = (async () => {
      for await (const ev of sub) events.push(ev.type);
    })();

    await execution.dispatch(runId);
    const run = await waitForTerminal(runId);
    await collector;

    // Terminal outcome is the authority: the run completed.
    expect(run?.status).toBe("completed");
    // Live updates flowed transiently (adapter-mapped events).
    expect(events).toContain("text_delta");
    // The Product Tool call went through the REAL MCP chain (the child's
    // scripted model called history_recent once).
    expect(events).toContain("product_tool_started");
    expect(events).toContain("product_tool_completed");

    // Conversation History: the Run's full canonical sequence (ADR 0017) —
    // assistant(tool_use) + tool(tool_result) + assistant(text) — committed
    // as separate ledger messages, in order.
    const ledgerMessages = convPort.getLedgerEntries(CONV).filter((e) => e.kind === "message");
    expect(ledgerMessages).toHaveLength(4); // seed user + 3 run messages
    const runMessages = ledgerMessages.filter((e) => e.senderMemberId === MEMBER);
    expect(runMessages).toHaveLength(3);
    // SURFACE CONTRACT: the canonical assistant Message must parse as a full
    // MessageRevision (messageId/state/updatedAt) - Web reducer and Lark
    // watcher skip entries that fail parseMessageRevision. The final answer
    // keeps the `run:<runId>:assistant:0` id the web waits on.
    const revision = parseMessageRevision(runMessages.at(-1)!.content);
    expect(revision).toMatchObject({
      messageId: assistantMessageId(runId, 0),
      role: "assistant",
      state: "done",
      conversationId: CONV,
    });
    expect(revision.updatedAt).toBeGreaterThan(0);

    // Agent Context: the ledger_message ref for the final message exists.
    const entries = await contextPort.listEntriesToLeaf(branchId);
    const refs = entries.filter((e) => e.type === "ledger_message");
    expect(refs.length).toBeGreaterThanOrEqual(1);

    // Replay the SAME dispatch: no second commit, no duplicate ledger row.
    await execution.dispatch(runId);
    const ledgerAfter = convPort.getLedgerEntries(CONV).filter((e) => e.kind === "message");
    expect(ledgerAfter).toHaveLength(4);
  }, 60_000);

  test("a follow-up input chains into a SECOND real child run (one Run / one loop)", async () => {
    const first = await backend.enqueueAndAcquire({
      conversationId: CONV,
      agentMemberId: MEMBER,
      backendKind: "coding_agent",
      mode: "normal",
      message: { role: "user", text: "chain first" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "e2e-chain-1",
    });
    expect(first.acquired).toBe(true);
    const followUp = await backend.enqueueAndAcquire({
      conversationId: CONV,
      agentMemberId: MEMBER,
      backendKind: "coding_agent",
      mode: "follow_up",
      message: { role: "user", text: "chain second" },
      defaultModel: { backendKind: "coding_agent", modelId: "fake/echo" },
      configRevision: 1,
      idempotencyKey: "e2e-chain-2",
    });
    expect(followUp.queued).toBe(true);

    await execution.dispatch(first.run!.runId);
    await waitForTerminal(first.run!.runId);

    // The queued follow_up became a FRESH run with its OWN child process.
    const inputs = await runPort.listInputs(first.run!.branchId);
    const followUpInput = inputs.find((i) => i.inputIdempotencyKey === "e2e-chain-2");
    expect(followUpInput).toBeDefined();
    const secondRunId = followUpInput!.runId!;
    expect(secondRunId).not.toBe(first.run!.runId);
    const secondRun = await waitForTerminal(secondRunId);
    expect(secondRun?.status).toBe("completed");

    // BOTH runs committed their own final assistant Message - the child
    // never accepted a second segment for the first runId. Filter by the
    // run-derived messageIds (shared conversation also carries the first
    // test's assistant message).
    const ledger = convPort.getLedgerEntries(CONV).filter((e) => e.kind === "message");
    const ourMessageIds = new Set([
      assistantMessageId(first.run!.runId, 0),
      assistantMessageId(secondRunId, 0),
    ]);
    const assistantCount = ledger.filter((e) => {
      if (e.senderMemberId !== MEMBER) return false;
      try {
        return ourMessageIds.has(parseMessageRevision(e.content).messageId);
      } catch {
        return false;
      }
    }).length;
    expect(assistantCount).toBe(2);

    // Run 2 was built from a FULL projection of the SAME Product Context
    // Branch: the exact projection function the execution service feeds the
    // child must include Run 1's canonical final Message. No SQLite
    // session, no resume - the branch IS the continuity.
    const projection = await projectAgentContext(
      { port: contextPort, ledgerResolver },
      { branchId },
    );
    const run1Message = projection.find(
      (item) =>
        item.message.role === "assistant" &&
        item.message.text === "done" &&
        item.productEntryId !== undefined,
    );
    expect(run1Message).toBeDefined();
    // Run 1's final Message also resolves through the ledger refs.
    expect(projection.some((item) => item.message.role === "assistant")).toBe(true);
  }, 60_000);
});
