import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createCheckpointEventsStore } from "./checkpoint-events-store.js";

function tmpDir() {
  return mkdtempSync("/tmp/checkpoint-events-store-test-");
}

/** Helper: create a WAL database with checkpoint_events schema (simulates agent sqlitePersistence setup). */
function createPersistenceDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(
    `CREATE TABLE IF NOT EXISTS checkpoint_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      event TEXT NOT NULL DEFAULT '{}'
    )`,
  );
  return db;
}

describe("createCheckpointEventsStore", () => {
  it("does not throw when opened on a readonly connection to a WAL database (B0 regression)", () => {
    const dir = tmpDir();
    const dbPath = join(dir, "test.db");
    try {
      // Write side: agent sqlitePersistence creates WAL db + schema
      const writer = createPersistenceDb(dbPath);
      writer.close();

      // Read side: main.ts:216 opens readonly for Ops consumption
      const reader = new Database(dbPath, { readonly: true });

      // This must not throw SQLITE_READONLY (was the B0 bug)
      expect(() => createCheckpointEventsStore(reader)).not.toThrow();

      // Basic query should also work
      const store = createCheckpointEventsStore(reader);
      expect(() => store.readBySpan("s1", "sp1")).not.toThrow();

      reader.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readBySpan returns empty array for no matching events", () => {
    const dir = tmpDir();
    const dbPath = join(dir, "test.db");
    try {
      const writer = createPersistenceDb(dbPath);
      writer.close();

      const reader = new Database(dbPath, { readonly: true });
      const store = createCheckpointEventsStore(reader);
      const events = store.readBySpan("nonexistent", "nonexistent");
      expect(events).toEqual([]);
      reader.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readBySpan returns matching events ordered by id", () => {
    const dir = tmpDir();
    const dbPath = join(dir, "test.db");
    try {
      const writer = createPersistenceDb(dbPath);
      // Insert some test events
      writer.run(
        `INSERT INTO checkpoint_events (session_id, span_id, ts, type, event) VALUES (?, ?, ?, ?, ?)`,
        [
          "sess-1",
          "span-1",
          1000,
          "model_end",
          JSON.stringify({ type: "model_end", blocks: [{ type: "text", text: "hi" }] }),
        ],
      );
      writer.run(
        `INSERT INTO checkpoint_events (session_id, span_id, ts, type, event) VALUES (?, ?, ?, ?, ?)`,
        ["sess-1", "span-1", 2000, "tool_end", JSON.stringify({ type: "tool_end", name: "read" })],
      );
      writer.run(
        `INSERT INTO checkpoint_events (session_id, span_id, ts, type, event) VALUES (?, ?, ?, ?, ?)`,
        [
          "sess-1",
          "span-2",
          1500,
          "model_end",
          JSON.stringify({ type: "model_end", blocks: [{ type: "text", text: "other" }] }),
        ],
      );
      writer.close();

      const reader = new Database(dbPath, { readonly: true });
      const store = createCheckpointEventsStore(reader);

      const span1Events = store.readBySpan("sess-1", "span-1");
      expect(span1Events).toHaveLength(2);
      expect(span1Events[0]!.ts).toBe(1000);
      expect(span1Events[0]!.type).toBe("model_end");
      expect(span1Events[1]!.ts).toBe(2000);
      expect(span1Events[1]!.type).toBe("tool_end");

      const span2Events = store.readBySpan("sess-1", "span-2");
      expect(span2Events).toHaveLength(1);
      expect(span2Events[0]!.type).toBe("model_end");

      reader.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
