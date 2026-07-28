import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const checkpointMessages = sqliteTable("checkpoint_messages", {
  sessionId: text().primaryKey(),
  messages: text().notNull(),
  updatedAt: integer({ mode: "number" }).notNull(),
});

export const checkpointInterrupts = sqliteTable("checkpoint_interrupts", {
  sessionId: text().primaryKey(),
  state: text().notNull(),
  createdAt: integer({ mode: "number" }).notNull(),
});

export const checkpointEvents = sqliteTable(
  "checkpoint_events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    sessionId: text().notNull(),
    spanId: text(),
    event: text().notNull(),
    ts: integer({ mode: "number" }).notNull(),
  },
  (table) => [index("idx_checkpoint_events_span").on(table.sessionId, table.spanId, table.id)],
);
