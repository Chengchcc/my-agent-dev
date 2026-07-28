import { Database } from "bun:sqlite";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type {
  CheckpointEvent,
  CheckpointEventRow,
  Checkpointer,
  InterruptState,
} from "./checkpointer.js";
import * as schema from "./schema.js";

export interface SqliteCheckpointerOptions {
  db: Database | string;
}

/** Ensure the checkpointer tables exist. For standalone harness use.
 *  Uses drizzle-kit migrate() with ledger tracking. */
export function ensureCheckpointerSchema(db: Database): void {
  const d = drizzle(db, { schema, casing: "snake_case" });
  const migrationsFolder = path.resolve(import.meta.dirname, "../../drizzle");
  migrate(d, { migrationsFolder });
}

export function sqliteCheckpointer(opts: SqliteCheckpointerOptions): Checkpointer {
  const db: Database = typeof opts.db === "string" ? new Database(opts.db) : opts.db;

  // Run drizzle-kit migrations (replaces hand-rolled SQLITE_CHECKPOINTER_MIGRATIONS + _migrations ledger).
  ensureCheckpointerSchema(db);

  const d = drizzle(db, { schema, casing: "snake_case" });

  const cp: Checkpointer = {
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

    async saveInterrupt(sessionId: string, state: InterruptState): Promise<void> {
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

    async consumeInterrupt(sessionId: string): Promise<InterruptState | null> {
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

    async appendEvent(
      sessionId: string,
      spanId: string | undefined,
      event: CheckpointEvent,
    ): Promise<void> {
      const json = JSON.stringify(event);
      const ts = "ts" in event ? (event as { ts: number }).ts : Date.now();
      d.insert(schema.checkpointEvents)
        .values({
          sessionId,
          spanId: spanId ?? null,
          event: json,
          ts,
        })
        .run();
    },

    async *readEvents(
      sessionId: string,
      opts?: { spanId?: string },
    ): AsyncIterable<CheckpointEventRow> {
      const conditions = [eq(schema.checkpointEvents.sessionId, sessionId)];
      if (opts?.spanId) {
        conditions.push(eq(schema.checkpointEvents.spanId, opts.spanId));
      }
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
          yield { ...event, spanId: row.spanId, ts: row.ts };
        } catch {
          /* skip corrupted rows */
        }
      }
    },

    async deleteThread(sessionId: string): Promise<void> {
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
  return cp;
}
