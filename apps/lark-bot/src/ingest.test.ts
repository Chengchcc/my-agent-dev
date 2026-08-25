import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { reserveInbound } from "./bindings-sqlite.js";
import type { LarkMessageEvent } from "./event-parser.js";
import { ingest } from "./ingest.js";

let dbCounter = 0;
function testDbPath() {
  return `/tmp/test-lark-ingest-${Date.now()}-${dbCounter++}.db`;
}

function makeDb(): Database {
  const db = new Database(testDbPath());
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_binding (
      lark_chat_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      chat_type TEXT NOT NULL, created_at INTEGER NOT NULL, pushed_seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS member_binding (
      lark_chat_id TEXT NOT NULL, lark_open_id TEXT NOT NULL, member_id TEXT NOT NULL,
      PRIMARY KEY (lark_chat_id, lark_open_id)
    );
    CREATE TABLE IF NOT EXISTS inbound_message (
      lark_event_id TEXT PRIMARY KEY, lark_message_id TEXT NOT NULL,
      lark_chat_id TEXT NOT NULL, conversation_id TEXT, ledger_seq INTEGER,
      status TEXT NOT NULL DEFAULT 'processing', created_at INTEGER NOT NULL,
      UNIQUE(lark_message_id)
    );
  `);
  return db;
}

// Simple fetch mock that returns responses in order
const originalFetch = globalThis.fetch;

type MockResponse = { body: unknown; status?: number };

function mockFetch(responses: MockResponse[]) {
  let i = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = (_url: string, _opts?: RequestInit) => {
    const resp = responses[i++]!;
    if (!resp) throw new Error(`Mock fetch exhausted at index ${i - 1}`);
    const status = resp.status ?? 200;
    const body = JSON.stringify(resp.body);
    return Promise.resolve(
      new Response(body, {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}

afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = originalFetch;
});

const baseEvent: LarkMessageEvent = {
  type: "im.message.receive_v1",
  event_id: "evt_001",
  timestamp: "1700000000000",
  id: "msg_001",
  message_id: "om_001",
  create_time: "1700000000000",
  chat_id: "oc_p2p_001",
  chat_type: "p2p",
  message_type: "text",
  sender_id: "ou_user001",
  content: "hello",
};

describe("ingest", () => {
  test("p2p message — creates conversation, posts message, addresses agent", async () => {
    const db = makeDb();

    mockFetch([
      { body: { conversationId: "conv_new" } }, // create conversation
      // server-derived 1:1 routing returns the triggered run
      { body: { seq: 1, triggeredRuns: [{ agentId: "mem-agent", runId: "run-1" }] } },
    ]);

    const result = await ingest(baseEvent, {
      db,
      selfAgentId: "agent_123",
      selfAgentName: "TestBot",
      botDisplayName: "TestBot",
      backendUrl: "http://localhost",
      profile: "test-profile",
    });

    expect(result.action).toBe("consumed");
    expect(result.triggered).toBe(true);
    expect(result.ledgerSeq).toBe(1);

    db.close();
  });

  test("idempotent — duplicate event_id is skipped", async () => {
    const db = makeDb();

    // Pre-reserve to simulate already-consumed event
    reserveInbound(db, "evt_dup", "om_dup", "oc_dup");

    const result = await ingest(
      { ...baseEvent, event_id: "evt_dup", message_id: "om_dup" },
      {
        db,
        selfAgentId: "agent_123",
        selfAgentName: "TestBot",
        botDisplayName: "TestBot",
        backendUrl: "http://localhost",
        profile: "test-profile",
      },
    );

    expect(result.action).toBe("skipped");
    expect(result.triggered).toBe(false);

    db.close();
  });

  test("group message without @bot — posts but doesn't trigger", async () => {
    const db = makeDb();

    mockFetch([{ body: { conversationId: "conv_grp" } }, { body: { seq: 2 } }]);

    const result = await ingest(
      {
        ...baseEvent,
        event_id: "evt_grp",
        message_id: "om_grp",
        chat_id: "oc_grp",
        chat_type: "group",
        content: "just chatting",
      },
      {
        db,
        selfAgentId: "agent_123",
        selfAgentName: "TestBot",
        botDisplayName: "TestBot",
        backendUrl: "http://localhost",
        profile: "test-profile",
      },
    );

    expect(result.action).toBe("consumed");
    expect(result.triggered).toBe(false); // no @mention

    db.close();
  });

  test("group message with @bot — triggers agent", async () => {
    const db = makeDb();

    mockFetch([{ body: { conversationId: "conv_grp2" } }, { body: { seq: 3 } }]);

    const result = await ingest(
      {
        ...baseEvent,
        event_id: "evt_grp2",
        message_id: "om_grp2",
        chat_id: "oc_grp2",
        chat_type: "group",
        content: "@TestBot help me",
      },
      {
        db,
        selfAgentId: "agent_123",
        selfAgentName: "TestBot",
        botDisplayName: "TestBot",
        backendUrl: "http://localhost",
        profile: "test-profile",
      },
    );

    expect(result.action).toBe("consumed");
    expect(result.triggered).toBe(true);

    db.close();
  });

  test("triggeredRuns — returns run IDs from backend response", async () => {
    const db = makeDb();

    mockFetch([
      { body: { conversationId: "conv_trig" } },
      { body: { seq: 4, triggeredRuns: [{ agentId: "agent_123", runId: "run_001" }] } },
    ]);

    const result = await ingest(
      { ...baseEvent, event_id: "evt_trig1", message_id: "om_trig1" },
      {
        db,
        selfAgentId: "agent_123",
        selfAgentName: "TestBot",
        botDisplayName: "TestBot",
        backendUrl: "http://localhost",
        profile: "test-profile",
      },
    );

    expect(result.action).toBe("consumed");
    expect(result.triggeredRuns).toHaveLength(1);
    expect(result.triggeredRuns[0]!.runId).toBe("run_001");
    expect(result.triggeredRuns[0]!.agentId).toBe("agent_123");

    db.close();
  });

  test("triggeredRuns — empty when no targets", async () => {
    const db = makeDb();

    mockFetch([
      { body: { conversationId: "conv_empty" } },
      { body: { seq: 5, triggeredRuns: [] } },
    ]);

    const result = await ingest(
      {
        ...baseEvent,
        event_id: "evt_empty",
        message_id: "om_empty",
        chat_id: "oc_grp3",
        chat_type: "group",
        content: "no mention here",
      },
      {
        db,
        selfAgentId: "agent_123",
        selfAgentName: "TestBot",
        botDisplayName: "TestBot",
        backendUrl: "http://localhost",
        profile: "test-profile",
      },
    );

    expect(result.action).toBe("consumed");
    expect(result.triggered).toBe(false);
    expect(result.triggeredRuns).toHaveLength(0);

    db.close();
  });

  test("onTriggeredRun callback — called for each triggered run", async () => {
    const db = makeDb();
    const triggered: Array<{ runId: string; conversationId: string; sourceMessageId: string }> = [];

    mockFetch([
      { body: { conversationId: "conv_cb" } },
      { body: { seq: 6, triggeredRuns: [{ agentId: "agent_123", runId: "run_cb1" }] } },
    ]);

    await ingest(
      { ...baseEvent, event_id: "evt_cb", message_id: "om_cb" },
      {
        db,
        selfAgentId: "agent_123",
        selfAgentName: "TestBot",
        botDisplayName: "TestBot",
        backendUrl: "http://localhost",
        profile: "test-profile",
        onTriggeredRun: (runId, conversationId, sourceMessageId) => {
          triggered.push({ runId, conversationId, sourceMessageId });
        },
      },
    );

    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.runId).toBe("run_cb1");
    expect(triggered[0]!.conversationId).toBe("conv_cb");
    expect(triggered[0]!.sourceMessageId).toBe("om_cb");

    db.close();
  });
});
