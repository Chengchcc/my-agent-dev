import type { Database } from "bun:sqlite";
import type { PendingActionResponse } from "@chengchenccc/agent-contract";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import { parsePendingAction } from "./adapter-sqlite-parse.js";
import {
  type AgentRun,
  AgentRunConflictError,
  isTerminalStatus,
  PendingActionAlreadyConsumedError,
} from "./domain.js";
import type { AgentRunPort } from "./ports.js";

type ActionMethods = Pick<
  AgentRunPort,
  "createPendingAction" | "consumePendingAction" | "getPendingAction"
>;

export function createActionMethods(db: Database): ActionMethods {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    async createPendingAction(runId, action) {
      const now = Date.now();
      return db.transaction(() => {
        const run = d.select().from(schema.agentRun).where(eq(schema.agentRun.runId, runId)).get();
        if (!run) throw new Error(`Agent Run not found: ${runId}`);
        if (run.status !== "running") {
          throw new Error(
            `Cannot create PendingAction: run ${runId} is ${run.status}, not running`,
          );
        }

        // Insert PendingAction (idempotent: duplicate actionId will fail via PK)
        d.insert(schema.pendingAction)
          .values({
            actionId: action.actionId,
            runId,
            kind: action.kind,
            payload: JSON.stringify(action.payload),
            status: "pending",
            createdAt: now,
          })
          .run();

        // CAS: run running -> waiting
        const updated = d
          .update(schema.agentRun)
          .set({ status: "waiting" })
          .where(and(eq(schema.agentRun.runId, runId), eq(schema.agentRun.status, "running")))
          .returning()
          .get();
        if (!updated) {
          throw new Error(`CAS failed: run ${runId} is not running`);
        }

        const row = d
          .select()
          .from(schema.pendingAction)
          .where(eq(schema.pendingAction.actionId, action.actionId))
          .get()!;
        return parsePendingAction(row);
      })();
    },

    async consumePendingAction(actionId, response: PendingActionResponse, responseIdempotencyKey) {
      return db.transaction(() => {
        const row = d
          .select()
          .from(schema.pendingAction)
          .where(eq(schema.pendingAction.actionId, actionId))
          .get();

        if (!row) throw new Error(`PendingAction not found: ${actionId}`);

        // Already resolved: same key = replay (return stored + fix run if needed),
        // different key = conflict.
        if (row.status === "resolved") {
          if (row.responseIdempotencyKey === responseIdempotencyKey) {
            // Verify run state: if waiting (crash after resolve), fix it;
            // if terminal, the data is corrupt and we must signal an error.
            const run = d
              .select()
              .from(schema.agentRun)
              .where(eq(schema.agentRun.runId, row.runId))
              .get();
            if (!run) throw new Error(`Run ${row.runId} not found for resolved action`);
            if (isTerminalStatus(run.status as AgentRun["status"])) {
              throw new AgentRunConflictError(row.runId);
            }
            if (run.status === "waiting") {
              d.update(schema.agentRun)
                .set({ status: "running" })
                .where(
                  and(eq(schema.agentRun.runId, row.runId), eq(schema.agentRun.status, "waiting")),
                )
                .run();
            }
            return { action: parsePendingAction(row), runId: row.runId };
          }
          throw new PendingActionAlreadyConsumedError(actionId);
        }
        if (row.status === "cancelled") {
          throw new PendingActionAlreadyConsumedError(actionId);
        }

        // Consume: CAS action pending -> resolved + CAS run waiting -> running.
        // Single transaction so if either fails, the whole operation rolls back.
        const now = Date.now();
        const result = d
          .update(schema.pendingAction)
          .set({
            status: "resolved",
            response: JSON.stringify(response.response),
            responseIdempotencyKey,
            resolvedAt: now,
          })
          .where(
            and(
              eq(schema.pendingAction.actionId, actionId),
              eq(schema.pendingAction.status, "pending"),
            ),
          )
          .returning()
          .get();

        if (!result) {
          throw new PendingActionAlreadyConsumedError(actionId);
        }

        // CAS run waiting -> running
        const resumed = d
          .update(schema.agentRun)
          .set({ status: "running" })
          .where(and(eq(schema.agentRun.runId, row.runId), eq(schema.agentRun.status, "waiting")))
          .returning()
          .get();

        if (!resumed) {
          throw new AgentRunConflictError(row.runId);
        }

        return {
          action: parsePendingAction(result),
          runId: row.runId,
        };
      })();
    },

    async getPendingAction(actionId) {
      const row = d
        .select()
        .from(schema.pendingAction)
        .where(eq(schema.pendingAction.actionId, actionId))
        .get();
      return row ? parsePendingAction(row) : null;
    },
  };
}
