import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type { IdGenerator } from "../agent-context/ports.js";
import type { ProductToolCallPort } from "./service.js";

/** SQLite implementation of the durable Product Tool call idempotency port.
 *  Read-only tools never write; only semantic mutations (history_retain)
 *  record a row. UNIQUE(run_id, call_id) makes replays return the stored
 *  result and conflicting inputs fail. */
export function sqliteProductToolCallAdapter(
  db: Database,
  idGen: IdGenerator = { ulid: () => crypto.randomUUID().replace(/-/g, "").slice(0, 26) },
): ProductToolCallPort {
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

    async retainHistoryMessageOnce({
      runId,
      callId,
      toolName,
      inputHash,
      branchId,
      ledgerSeq,
      result,
    }) {
      const now = Date.now();
      return db.transaction(() => {
        // 0. TOCTOU guard: the run must still be running AND own the branch
        //    inside the same transaction that mutates the branch (the service
        //    validated scope earlier, but a concurrent finalize/terminal
        //    commit must not race this mutation).
        const run = d
          .select({ status: schema.agentRun.status, branchId: schema.agentRun.branchId })
          .from(schema.agentRun)
          .where(eq(schema.agentRun.runId, runId))
          .get();
        if (!run || run.status !== "running" || run.branchId !== branchId) {
          throw new Error(`run ${runId} is not an active owner of branch ${branchId}`);
        }

        // 1. Durable call idempotency first: an existing row is the terminal
        //    authority for this (runId, callId) - exact replay returns the
        //    stored result, a different tool/input conflicts.
        const existing = d
          .select()
          .from(schema.productToolCall)
          .where(
            and(eq(schema.productToolCall.runId, runId), eq(schema.productToolCall.callId, callId)),
          )
          .get();
        if (existing) {
          if (existing.toolName !== toolName || existing.inputHash !== inputHash) {
            return { outcome: "conflict" as const };
          }
          return { outcome: "stored" as const, result: existing.result ?? result };
        }

        // 2. Append the ledger_message ref (unless already retained - e.g. a
        //    crash between the append and the call record in a previous run).
        const branch = d
          .select()
          .from(schema.agentContextBranch)
          .where(eq(schema.agentContextBranch.branchId, branchId))
          .get();
        if (!branch) throw new Error(`Branch not found: ${branchId}`);
        const alreadyRetained = d
          .select()
          .from(schema.agentContextEntry)
          .where(
            and(
              eq(schema.agentContextEntry.treeId, branch.treeId),
              eq(schema.agentContextEntry.type, "ledger_message"),
              eq(schema.agentContextEntry.ledgerSeq, ledgerSeq),
            ),
          )
          .get();
        if (!alreadyRetained) {
          const entryId = idGen.ulid();
          d.insert(schema.agentContextEntry)
            .values({
              entryId,
              treeId: branch.treeId,
              parentId: branch.leafEntryId,
              type: "ledger_message",
              payload: "{}",
              ledgerSeq,
              createdAt: now,
            })
            .run();
          // CAS the branch revision: a concurrent retain on the SAME branch
          // must not silently drop one update (that would orphan an entry).
          // SQLite serializes transactions on one connection, but the CAS is
          // the data-model guarantee across connections/instances.
          const cas = d
            .update(schema.agentContextBranch)
            .set({ leafEntryId: entryId, revision: branch.revision + 1 })
            .where(
              and(
                eq(schema.agentContextBranch.branchId, branchId),
                eq(schema.agentContextBranch.revision, branch.revision),
              ),
            )
            .returning({ branchId: schema.agentContextBranch.branchId })
            .get();
          if (!cas) {
            throw new Error(
              `branch ${branchId} revision conflict while retaining ledger seq ${ledgerSeq}`,
            );
          }
        }

        // 3. Record the call terminal result in the SAME transaction.
        d.insert(schema.productToolCall)
          .values({
            runId,
            callId,
            toolName,
            inputHash,
            status: "completed",
            result,
            createdAt: now,
            completedAt: now,
          })
          .run();
        return { outcome: alreadyRetained ? ("stored" as const) : ("retained" as const), result };
      })();
    },
  };
}
