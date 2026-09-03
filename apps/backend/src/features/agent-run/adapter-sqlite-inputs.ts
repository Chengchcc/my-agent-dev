import type { Database } from "bun:sqlite";
import { and, eq, inArray, isNull, not, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import { parseInput } from "./adapter-sqlite-parse.js";
import type { BranchInput, ClaimedBranchInput } from "./domain.js";
import type { AgentRunPort } from "./ports.js";

type InputQueueMethods = Pick<
  AgentRunPort,
  | "claimInputForRun"
  | "cancelInput"
  | "cancelRunInput"
  | "deliverSteerInput"
  | "markInputAccepted"
  | "listDeliveringInputs"
  | "listIdleBranchesWithPendingInputs"
  | "listInputs"
  | "getInput"
  | "listPendingInputsForConversation"
  | "updateInput"
>;

export function createInputQueueMethods(db: Database): InputQueueMethods {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    /** Claim the input bound to THIS run (run_id = ?). One Run / one
     *  input: pending inputs are never bound to a run by a claim - only
     *  acquire (enqueue/acquireNextRun) binds them. */
    async claimInputForRun(runId: string): Promise<ClaimedBranchInput | null> {
      const row = d
        .select()
        .from(schema.branchInputQueue)
        .where(
          and(
            eq(schema.branchInputQueue.runId, runId),
            inArray(schema.branchInputQueue.status, ["pending", "delivering"]),
          ),
        )
        .orderBy(schema.branchInputQueue.seq)
        .get();
      if (!row) return null;
      return { input: parseInput(row), runId: row.runId! };
    },

    async cancelInput(inputId: string): Promise<void> {
      d.update(schema.branchInputQueue)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(schema.branchInputQueue.inputId, inputId),
            inArray(schema.branchInputQueue.status, ["pending", "delivering"]),
          ),
        )
        .run();
    },

    async cancelRunInput(runId: string): Promise<void> {
      d.update(schema.branchInputQueue)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(schema.branchInputQueue.runId, runId),
            inArray(schema.branchInputQueue.status, ["pending", "delivering"]),
          ),
        )
        .run();
    },

    async deliverSteerInput(inputId: string, runId: string): Promise<BranchInput | null> {
      const claimed = d
        .update(schema.branchInputQueue)
        .set({ status: "delivering", runId })
        .where(
          and(
            eq(schema.branchInputQueue.inputId, inputId),
            eq(schema.branchInputQueue.status, "pending"),
          ),
        )
        .returning()
        .get();
      return claimed ? parseInput(claimed) : null;
    },

    async markInputAccepted(inputId: string): Promise<BranchInput> {
      // CAS from delivering to delivered
      const result = d
        .update(schema.branchInputQueue)
        .set({ status: "delivered", deliveredAt: Date.now() })
        .where(
          and(
            eq(schema.branchInputQueue.inputId, inputId),
            eq(schema.branchInputQueue.status, "delivering"),
          ),
        )
        .returning()
        .get();

      if (result) return parseInput(result);

      // Already delivered? Return existing (idempotent)
      const existing = d
        .select()
        .from(schema.branchInputQueue)
        .where(eq(schema.branchInputQueue.inputId, inputId))
        .get();
      if (!existing) throw new Error(`Input not found: ${inputId}`);
      if (existing.status === "delivered") return parseInput(existing);
      throw new Error(`Input ${inputId} cannot be accepted from status ${existing.status}`);
    },

    async listDeliveringInputs() {
      const rows = d
        .select()
        .from(schema.branchInputQueue)
        .where(eq(schema.branchInputQueue.status, "delivering"))
        .orderBy(schema.branchInputQueue.seq)
        .all();
      return rows
        .filter((r) => r.runId != null)
        .map((r) => ({ input: parseInput(r), runId: r.runId! }));
    },

    /** Crash-gap recovery: branches whose pending non-steer input never
     *  became a Run (crash between enqueue and acquire, or after a run
     *  settled without chaining). Ordered by the oldest pending input (FIFO);
     *  the per-branch active-run guard lives inside acquireNextRun. */
    async listIdleBranchesWithPendingInputs() {
      const rows = d
        .select({
          branchId: schema.branchInputQueue.branchId,
          firstSeq: sql<number>`MIN(${schema.branchInputQueue.seq})`,
        })
        .from(schema.branchInputQueue)
        .where(
          and(
            eq(schema.branchInputQueue.status, "pending"),
            isNull(schema.branchInputQueue.runId),
            not(eq(schema.branchInputQueue.mode, "steer")),
          ),
        )
        .groupBy(schema.branchInputQueue.branchId)
        .orderBy(sql`MIN(${schema.branchInputQueue.seq})`)
        .all();
      return rows.map((r) => r.branchId);
    },

    async listInputs(branchId: string) {
      const rows = d
        .select()
        .from(schema.branchInputQueue)
        .where(eq(schema.branchInputQueue.branchId, branchId))
        .orderBy(schema.branchInputQueue.seq)
        .all();
      return rows.map(parseInput);
    },

    async getInput(inputId: string) {
      const row = d
        .select()
        .from(schema.branchInputQueue)
        .where(eq(schema.branchInputQueue.inputId, inputId))
        .get();
      return row ? parseInput(row) : null;
    },

    async listPendingInputsForConversation(conversationId: string) {
      const rows = d
        .select()
        .from(schema.branchInputQueue)
        .innerJoin(
          schema.agentContextBranch,
          eq(schema.branchInputQueue.branchId, schema.agentContextBranch.branchId),
        )
        .innerJoin(
          schema.agentContextTree,
          eq(schema.agentContextBranch.treeId, schema.agentContextTree.treeId),
        )
        .innerJoin(
          schema.conversation,
          eq(schema.agentContextTree.conversationId, schema.conversation.conversationId),
        )
        .where(
          and(
            eq(schema.agentContextTree.conversationId, conversationId),
            eq(schema.branchInputQueue.status, "pending"),
          ),
        )
        .orderBy(schema.branchInputQueue.seq)
        .all();
      return rows.map((r) => ({
        ...parseInput(r.branch_input_queue),
        agentId: r.conversation.agentId ?? "",
      }));
    },

    async updateInput(inputId: string, message: BranchInput["message"]) {
      const updated = d
        .update(schema.branchInputQueue)
        .set({ message: JSON.stringify(message) })
        .where(
          and(
            eq(schema.branchInputQueue.inputId, inputId),
            eq(schema.branchInputQueue.status, "pending"),
          ),
        )
        .returning({ inputId: schema.branchInputQueue.inputId })
        .get();
      return updated != null;
    },
  };
}
