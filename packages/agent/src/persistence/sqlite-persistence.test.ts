import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Message } from "@my-agent-team/message";
import { sqlitePersistence } from "./sqlite-persistence.js";

function tmpDb(): string {
  return `/tmp/split-compat-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
}

describe("sqlitePersistence legacy compatibility", () => {
  test("messageStore reads legacy checkpoint_messages", async () => {
    const dbPath = tmpDb();
    // Let migration create tables, then write legacy data via raw SQL
    const stores = sqlitePersistence({ db: dbPath });

    const msgs: Message[] = [{ role: "user", text: "hello" }];
    const db = new Database(dbPath);
    db.run(
      "INSERT OR REPLACE INTO checkpoint_messages (session_id, messages, updated_at) VALUES ('s1', ?, ?)",
      [JSON.stringify(msgs), Date.now()],
    );
    db.close();

    const loaded = await stores.messageStore.load("s1");
    expect(loaded).toBeDefined();
    expect(loaded![0]?.text).toBe("hello");
    try {
      unlinkSync(dbPath);
    } catch {
      /* */
    }
  });

  test("interruptStore reads legacy checkpoint_interrupts", async () => {
    const dbPath = tmpDb();
    const stores = sqlitePersistence({ db: dbPath });

    const state = {
      pendingTool: { call: { name: "approve", input: {} }, reason: "t" },
      ts: Date.now(),
    };
    const db = new Database(dbPath);
    db.run(
      "INSERT OR REPLACE INTO checkpoint_interrupts (session_id, state, created_at) VALUES ('s1', ?, ?)",
      [JSON.stringify(state), Date.now()],
    );
    db.close();

    const consumed = await stores.interruptStore.consumeInterrupt("s1");
    expect(consumed).toBeDefined();
    expect(consumed!.pendingTool.call.name).toBe("approve");
    const again = await stores.interruptStore.consumeInterrupt("s1");
    expect(again).toBeNull();
    try {
      unlinkSync(dbPath);
    } catch {
      /* */
    }
  });
});

test("eventLog reads legacy checkpoint_events", async () => {
  const dbPath = tmpDb();
  const stores = sqlitePersistence({ db: dbPath });

  const db = new Database(dbPath);
  db.run(
    "INSERT INTO checkpoint_events (session_id, span_id, event, ts) VALUES ('s1', 'sp1', ?, 1)",
    [
      JSON.stringify({
        type: "model_end",
        usage: { input: 10, output: 5 },
        model: "test",
        step: 1,
        latencyMs: 100,
        ts: 1,
      }),
    ],
  );
  db.run(
    "INSERT INTO checkpoint_events (session_id, span_id, event, ts) VALUES ('s1', 'sp2', ?, 2)",
    [
      JSON.stringify({
        type: "model_end",
        usage: { input: 3, output: 2 },
        model: "test",
        step: 1,
        latencyMs: 50,
        ts: 2,
      }),
    ],
  );
  db.close();

  const span1: unknown[] = [];
  for await (const e of stores.eventLog.readEvents("s1", { spanId: "sp1" })) span1.push(e);
  expect(span1.length).toBe(1);

  const all: unknown[] = [];
  for await (const e of stores.eventLog.readEvents("s1")) all.push(e);
  expect(all.length).toBe(2);
  try {
    unlinkSync(dbPath);
  } catch {
    /* */
  }
});
