import { Database } from "bun:sqlite";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { CheckpointEvent, CheckpointEventRow, EventLog } from "./event-log.js";
import type { InterruptState, InterruptStore } from "./interrupt-store.js";
import type { MessageStore } from "./message-store.js";
import * as schema from "./schema.js";

export interface SqlitePersistenceOptions {
  db: Database | string;
}

function ensureSchema(db: Database): void {
  const d = drizzle(db, { schema, casing: "snake_case" });
  const migrationsFolder = path.resolve(import.meta.dirname, "../../drizzle");
  migrate(d, { migrationsFolder });
}

/** One DB connection, three narrow persistence ports. */
export function sqlitePersistence(opts: SqlitePersistenceOptions) {
  const db: Database = typeof opts.db === "string" ? new Database(opts.db) : opts.db;
  ensureSchema(db);
  const d = drizzle(db, { schema, casing: "snake_case" });

  const messageStore: MessageStore = {
    async save(sessionId, messages) {
      const json = JSON.stringify(messages);
      const now = Date.now();
      d.insert(schema.checkpointMessages)
        .values({ sessionId, messages: json, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.checkpointMessages.sessionId,
          set: { messages: json, updatedAt: now },
        })
        .run();
    },

    async load(sessionId) {
      const row = d
        .select({ messages: schema.checkpointMessages.messages })
        .from(schema.checkpointMessages)
        .where(eq(schema.checkpointMessages.sessionId, sessionId))
        .get();
      if (!row) return null;
      try {
        return JSON.parse(row.messages);
      } catch {
        return null;
      }
    },

    async deleteThread(sessionId) {
      d.delete(schema.checkpointMessages)
        .where(eq(schema.checkpointMessages.sessionId, sessionId))
        .run();
      d.delete(schema.checkpointInterrupts)
        .where(eq(schema.checkpointInterrupts.sessionId, sessionId))
        .run();
      d.delete(schema.checkpointEvents)
        .where(eq(schema.checkpointEvents.sessionId, sessionId))
        .run();
    },
  };

  const eventLog: EventLog = {
    async appendEvent(sessionId, spanId, event) {
      const json = JSON.stringify(event);
      const ts = "ts" in event ? (event as { ts: number }).ts : Date.now();
      d.insert(schema.checkpointEvents)
        .values({ sessionId, spanId: spanId ?? null, event: json, ts })
        .run();
    },

    async *readEvents(sessionId, opts?) {
      const conditions = [eq(schema.checkpointEvents.sessionId, sessionId)];
      if (opts?.spanId) conditions.push(eq(schema.checkpointEvents.spanId, opts.spanId));
      const rows = d
        .select({
          event: schema.checkpointEvents.event,
          spanId: schema.checkpointEvents.spanId,
          ts: schema.checkpointEvents.ts,
        })
        .from(schema.checkpointEvents)
        .where(and(...conditions))
        .orderBy(schema.checkpointEvents.id)
        .all();
      for (const row of rows) {
        try {
          const event = JSON.parse(row.event) as CheckpointEvent;
          yield { ...event, spanId: row.spanId, ts: row.ts } as CheckpointEventRow;
        } catch {
          /* skip corrupted */
        }
      }
    },
  };

  const interruptStore: InterruptStore = {
    async saveInterrupt(sessionId, state) {
      const json = JSON.stringify(state);
      const now = Date.now();
      d.insert(schema.checkpointInterrupts)
        .values({ sessionId, state: json, createdAt: now })
        .onConflictDoUpdate({
          target: schema.checkpointInterrupts.sessionId,
          set: { state: json, createdAt: now },
        })
        .run();
    },

    async consumeInterrupt(sessionId) {
      const result = d.transaction((tx) => {
        const row = tx
          .select({ state: schema.checkpointInterrupts.state })
          .from(schema.checkpointInterrupts)
          .where(eq(schema.checkpointInterrupts.sessionId, sessionId))
          .get();
        if (!row) return null;
        tx.delete(schema.checkpointInterrupts)
          .where(eq(schema.checkpointInterrupts.sessionId, sessionId))
          .run();
        try {
          return JSON.parse(row.state) as InterruptState;
        } catch {
          return null;
        }
      });
      return result;
    },
  };

  return { messageStore, eventLog, interruptStore };
}

