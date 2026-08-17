import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { MessageRevision } from "@chengchenccc/message";
import { renderRevision } from "./render.js";

function makeRevision(overrides: Partial<MessageRevision> = {}): MessageRevision {
  return {
    messageId: "msg:test:1",
    role: "assistant",
    state: "done",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("renderRevision (used by SSE watcher)", () => {
  test("renders agent text reply from blocks", () => {
    const rev = makeRevision({
      blocks: [{ type: "text", text: "Hello from agent" }],
    });
    expect(renderRevision(rev)).toBe("Hello from agent");
  });

  test("renders simple text", () => {
    expect(renderRevision(makeRevision({ text: "simple" }))).toBe("simple");
  });

  test("renders empty as fallback", () => {
    expect(renderRevision(makeRevision())).toBe("[Unsupported content]");
  });
});

describe("SSE watcher pushed_seq advancement", () => {
  const DB_PATH = `:memory:`;

  function setupDb(): Database {
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_binding (
        lark_chat_id TEXT NOT NULL,
        lark_open_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        PRIMARY KEY (lark_chat_id, lark_open_id)
      );
      CREATE TABLE IF NOT EXISTS chat_binding (
        lark_chat_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        pushed_seq INTEGER NOT NULL DEFAULT 0
      );
    `);
    return db;
  }

  test("pushed_seq advances for non-message entries", () => {
    const db = setupDb();
    const larkChatId = "oc_test";
    db.run(
      "INSERT INTO chat_binding (lark_chat_id, conversation_id, chat_type, created_at, pushed_seq) VALUES (?, ?, ?, ?, 0)",
      [larkChatId, "conv_test", "group", Date.now()],
    );

    db.run("UPDATE chat_binding SET pushed_seq = ? WHERE lark_chat_id = ?", [42, larkChatId]);
    const row = db
      .query("SELECT pushed_seq FROM chat_binding WHERE lark_chat_id = ?")
      .get(larkChatId) as { pushed_seq: number };
    expect(row.pushed_seq).toBe(42);
    db.close();
  });
});
