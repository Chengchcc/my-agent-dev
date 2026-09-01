import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { Elysia } from "elysia";
import {
  createAgentContextService,
  sqliteAgentContextAdapter,
} from "../../src/features/agent-context/index.js";
import { sqliteConversationAdapter } from "../../src/features/conversation/adapter-sqlite.js";
import { conversationRoutes } from "../../src/features/conversation/http.js";
import {
  type ConversationServiceDeps,
  createConversationService,
} from "../../src/features/conversation/service.js";
import { openDb } from "../../src/infra/sqlite/db.js";

const dbPath = `/tmp/test-e2e-conv-${Date.now()}.db`;
const db = openDb(dbPath);
const port = sqliteConversationAdapter(db);

const contextPort = sqliteAgentContextAdapter(db, {
  ulid: () => `c-${Math.random().toString(36).slice(2, 8)}`,
});
const ledgerResolver = {
  async resolveMessage(conversationId: string, ledgerSeq: number) {
    const hit = port.getLedgerEntry(conversationId, ledgerSeq);
    return hit?.kind === "message" ? (hit.content as never) : null;
  },
};
const contextSvc = createAgentContextService({
  port: contextPort,
  idGen: { ulid: () => `x-${Math.random().toString(36).slice(2, 8)}` },
  ledgerResolver,
});

let idCount = 0;
const idGen = () => `e2e-${idCount++}`;

// Track agent runs triggered by postMessage
const runLog: Array<{ agentId: string; runId: string }> = [];

const deps: ConversationServiceDeps = {
  port,
  contextService: contextSvc,
  dispatchRun: async () => {},
  injectSteer: async () => {},
  isLive: () => false,
  isInflight: () => false,
  abortStaleRun: async () => {},
  resolveDefaultModel: async () => ({ backendKind: "oma", modelId: "m" }),
  idGen,
  agentRunService: {
    async enqueueAndAcquire(input: {
      agentId: string;
      conversationId: string;
      idempotencyKey: string;
    }) {
      const runId = `run-${runLog.length}`;
      runLog.push({ agentId: input.agentId, runId });
      return {
        acquired: true,
        queued: false,
        replayed: false,
        run: {
          runId,
          branchId: "b",
          conversationId: input.conversationId,
          agentId: input.agentId,
          modelRef: { backendKind: "oma", modelId: "m" },
          status: "running",
          idempotencyKey: input.idempotencyKey,
          terminalResult: null,
          configRevision: 1,
          productTools: null,
          createdAt: Date.now(),
          terminalAt: null,
        },
        inputId: `in-${runId}`,
      };
    },
    async claimInputForRun() {
      return null;
    },
    async acquireNextRun() {
      return null;
    },
    async cancelInput() {
      return;
    },
    async cancelRunInput() {
      return;
    },
    async markInputAccepted(inputId: string) {
      return { inputId } as never;
    },
    async createPendingAction(
      runId: string,
      action: { kind: string; payload: Readonly<Record<string, unknown>> },
    ) {
      return { runId, actionId: "a", ...action } as never;
    },
    async consumePendingAction(actionId: string) {
      return { action: { actionId } as never, runId: "r" };
    },
    async finalizeRun(runId: string) {
      return { runId } as never;
    },
    async getRun(_runId: string) {
      return null;
    },
    async getActiveRun(_branchId: string) {
      return null;
    },
    async listInputs(_branchId: string) {
      return [];
    },
  } as never,
};

const svc = createConversationService(deps);
const app = new Elysia().use(conversationRoutes(svc, idGen));

afterAll(() => {
  db.close();
  try {
    unlinkSync(dbPath);
  } catch {
    /* best-effort */
  }
});

describe("E2E Conversation lifecycle", () => {
  test("create conversation -> add members -> post message -> agent triggered", async () => {
    // 1. Create conversation
    const createResp = await app.handle(
      new Request("http://localhost/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "test-agent" }),
      }),
    );
    expect(createResp.status).toBe(201);
    const created = (await createResp.json()) as { conversationId: string };
    const convId = created.conversationId;
    expect(convId).toBeDefined();

    // 2. Get conversation
    const getResp = await app.handle(new Request(`http://localhost/api/conversations/${convId}`));
    expect(getResp.status).toBe(200);
    const conv = (await getResp.json()) as { conversationId: string; agentId: string | null };
    expect(conv.agentId).toBe("test-agent");

    // 3. List conversations
    const listResp = await app.handle(new Request("http://localhost/api/conversations"));
    expect(listResp.status).toBe(200);
    const list = (await listResp.json()) as unknown[];
    expect(list.length).toBeGreaterThanOrEqual(1);

    // 4. Post message addressed to agent -> triggers startAgentRun
    runLog.length = 0;
    const msgResp = await app.handle(
      new Request(`http://localhost/api/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Hello agent!" }),
      }),
    );
    expect(msgResp.status).toBe(202);
    const msgResult = (await msgResp.json()) as {
      seq: number;
      triggeredRuns: Array<{ agentId: string }>;
    };
    expect(msgResult.seq).toBeGreaterThan(0);
    expect(msgResult.triggeredRuns.length).toBe(1);
    expect(msgResult.triggeredRuns[0]!.agentId).toBe("test-agent");

    // Verify the Agent Run was enqueued for the addressed member
    expect(runLog.length).toBe(1);
    expect(runLog[0]!.agentId).toBe("test-agent");
    expect(runLog[0]!.runId).toBeTruthy();
  });

  test("delete conversation", async () => {
    // Create then delete
    const createResp = await app.handle(
      new Request("http://localhost/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "test-agent",
        }),
      }),
    );
    const { conversationId } = (await createResp.json()) as { conversationId: string };

    const delResp = await app.handle(
      new Request(`http://localhost/api/conversations/${conversationId}`, { method: "DELETE" }),
    );
    expect(delResp.status).toBe(204);

    // Get after delete -> 404
    const getResp = await app.handle(
      new Request(`http://localhost/api/conversations/${conversationId}`),
    );
    expect(getResp.status).toBe(404);
  });
});
