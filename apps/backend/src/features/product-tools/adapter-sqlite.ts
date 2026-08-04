import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type { ProductToolCallPort } from "./service.js";

/** SQLite implementation of the durable Product Tool call idempotency port.
 *  Read-only tools never write; only semantic mutations (history_retain)
 *  record a row. UNIQUE(run_id, call_id) makes replays return the stored
 *  result and conflicting inputs fail. */
export function sqliteProductToolCallAdapter(db: Database): ProductToolCallPort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    async getCall(runId, callId) {
      const row = d
        .select()
        .from(schema.productToolCall)
        .where(
          and(eq(schema.productToolCall.runId, runId), eq(schema.productToolCall.callId, callId)),
        )
        .get();
      if (!row) return null;
      return {
        toolName: row.toolName,
        inputHash: row.inputHash,
        result: row.result,
        error: row.error,
      };
    },

    async recordCall({ runId, callId, toolName, inputHash, result }) {
      d.insert(schema.productToolCall)
        .values({
          runId,
          callId,
          toolName,
          inputHash,
          status: "completed",
          result,
          createdAt: Date.now(),
          completedAt: Date.now(),
        })
        .run();
    },
  };
}
