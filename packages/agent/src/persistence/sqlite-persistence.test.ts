import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
