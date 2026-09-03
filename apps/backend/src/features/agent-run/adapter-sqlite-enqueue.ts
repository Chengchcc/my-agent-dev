import type { Database } from "bun:sqlite";
import { and, eq, gt, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type { IdGenerator } from "../agent-context/ports.js";
import { parseRun } from "./adapter-sqlite-parse.js";
import {
  ACTIVE_RUN_STATUSES,
  type AcquireAgentRunCommand,
  type AcquireAgentRunResult,
  type AgentRun,
} from "./domain.js";
import type { AgentRunPort } from "./ports.js";

export function createEnqueueMethod(db: Database, deps: { idGen: IdGenerator }) {
  const d = drizzle(db, { schema, casing: "snake_case" });

  const method: Pick<AgentRunPort, "enqueueAndAcquire"> = {
    async enqueueAndAcquire(command: AcquireAgentRunCommand): Promise<AcquireAgentRunResult> {
      const inputId = deps.idGen.ulid();
      const now = Date.now();

      // Run everything in one immediate transaction
      const txn = db.transaction(() => {
        // 1. Idempotently insert the input - both delivery and input idempotency
        //    keys prevent duplicate operations.
        try {
          d.insert(schema.branchInputQueue)
            .values({
              inputId,
              branchId: command.branchId,
              mode: command.mode,
              message: JSON.stringify(command.message),
              status: "pending",
              deliveryIdempotencyKey: command.deliveryIdempotencyKey,
              inputIdempotencyKey: command.inputIdempotencyKey,
              // Request-time config snapshot: the promoted Run uses THIS,
              // never the previous Run's config.
              modelRef: JSON.stringify(command.defaultModel),
              configRevision: command.configRevision,
              workspaceRoot: command.workspace?.root ?? null,
              workspaceAccess: command.workspace?.access ?? null,
              systemPrompt: command.systemPrompt ?? null,
              skillRoots: command.skillRoots ? JSON.stringify(command.skillRoots) : null,
              permissionMode: command.permissionMode ?? null,
              workflowBudgetTokens: command.workflowBudgetTokens ?? null,
              createdAt: now,
            })
            .run();
        } catch {
          // Duplicate input idempotency key: check for exact replay vs conflict.
          const existing = d
            .select()
            .from(schema.branchInputQueue)
            .where(
              and(
                eq(schema.branchInputQueue.branchId, command.branchId),
                eq(schema.branchInputQueue.inputIdempotencyKey, command.inputIdempotencyKey),
              ),
            )
            .get();
          if (existing) {
            // Compare stable content: same key + same payload = replay, different = conflict.
            const sameMode = existing.mode === command.mode;
            const sameMessage = existing.message === JSON.stringify(command.message);
            if (!sameMode || !sameMessage) {
              throw new Error(
                `Input idempotency key ${command.inputIdempotencyKey} reused with different payload or mode`,
              );
            }
            // Return original result: if previously acquired, return the run.
            return {
              acquired: !!existing.runId,
              queued: !existing.runId,
              replayed: true,
              run: existing.runId
                ? parseRun(
                    d
                      .select()
                      .from(schema.agentRun)
                      .where(eq(schema.agentRun.runId, existing.runId))
                      .get()!,
                  )
                : undefined,
              inputId: existing.inputId,
            } satisfies AcquireAgentRunResult;
          }
          // Delivery key collision: always conflict, never guess replay.
          throw new Error(
            `Delivery idempotency key ${command.deliveryIdempotencyKey} collision — not a recognized replay`,
          );
        }
        const activeRun = d
          .select()
          .from(schema.agentRun)
          .where(
            and(
              eq(schema.agentRun.branchId, command.branchId),
              inArray(schema.agentRun.status, [...ACTIVE_RUN_STATUSES]),
            ),
          )
          .get();

        if (activeRun) {
          return {
            acquired: false,
            queued: true,
            replayed: false,
            inputId,
          } satisfies AcquireAgentRunResult;
        }

        // A steer input never creates a Run: steer belongs to the CURRENT
        // active Run. With no active Run the steer cannot be delivered -
        // cancel it explicitly instead of silently converting it into a
        // normal input (the caller surfaces the explicit failure).
        if (command.mode === "steer") {
          d.update(schema.branchInputQueue)
            .set({ status: "cancelled" })
            .where(eq(schema.branchInputQueue.inputId, inputId))
            .run();
          return {
            acquired: false,
            queued: false,
            replayed: false,
            cancelled: true,
            inputId,
          } satisfies AcquireAgentRunResult;
        }

        // 3. Validate command scope: branch must belong to the claimed
        //    conversation, and the default model must match the branch's
        //    backend kind.
        const scopedBranch = d
          .select()
          .from(schema.agentContextBranch)
          .innerJoin(
            schema.agentContextTree,
            eq(schema.agentContextBranch.treeId, schema.agentContextTree.treeId),
          )
          .where(eq(schema.agentContextBranch.branchId, command.branchId))
          .get();
        if (
          !scopedBranch ||
          scopedBranch.agent_context_tree.conversationId !== command.conversationId ||
          scopedBranch.agent_context_branch.backendKind !== command.defaultModel.backendKind
        ) {
          throw new Error(
            `Scope mismatch: branch ${command.branchId} does not belong to ${command.conversationId} or backend kind mismatch`,
          );
        }

        // 4. CAS the branch revision
        const casResult = d
          .update(schema.agentContextBranch)
          .set({ revision: command.expectedRevision + 1 })
          .where(
            and(
              eq(schema.agentContextBranch.branchId, command.branchId),
              eq(schema.agentContextBranch.revision, command.expectedRevision),
            ),
          )
          .returning()
          .get();

        if (!casResult) {
          // CAS failed: branch was modified concurrently
          return {
            acquired: false,
            queued: true,
            replayed: false,
            inputId,
          } satisfies AcquireAgentRunResult;
        }

        // 4. Read Conversation History after ledgerCursor
        const branch = casResult;
        const ledgerEntries = d
          .select()
          .from(schema.conversationLedger)
          .where(
            and(
              eq(schema.conversationLedger.conversationId, command.conversationId),
              gt(schema.conversationLedger.seq, branch.ledgerCursor),
              eq(schema.conversationLedger.undone, 0),
            ),
          )
          .orderBy(schema.conversationLedger.seq)
          .all();

        // 5. Filter by visibility: non-internal messages only (1:1 collapse
        //    pulled forward from cut 3 — addressedTo/sender routing is gone).
        const eligible = ledgerEntries.filter((e) => {
          if (e.kind !== "message") return false;
          try {
            const message = JSON.parse(e.content) as { visibility?: string };
            if (message.visibility === "internal") return false;
          } catch {
            // Corrupt content: skip to avoid polluting context
            return false;
          }
          return true;
        });

        // 6. Select latest 20 in ledger order
        const selected = eligible.slice(-20);

        // 7. Append Ledger Message refs to Context
        let parentId = branch.leafEntryId;
        for (const entry of selected) {
          const entryId = deps.idGen.ulid();
          d.insert(schema.agentContextEntry)
            .values({
              entryId,
              treeId: branch.treeId,
              parentId,
              type: "ledger_message",
              payload: "{}",
              ledgerSeq: entry.seq,
              createdAt: now,
            })
            .run();
          parentId = entryId;
        }

        // 8. Advance ledgerCursor to the highest scanned ledger seq
        const newCursor =
          ledgerEntries.length > 0
            ? ledgerEntries[ledgerEntries.length - 1]!.seq
            : branch.ledgerCursor;
        d.update(schema.agentContextBranch)
          .set({
            ledgerCursor: newCursor,
            leafEntryId: parentId,
          })
          .where(eq(schema.agentContextBranch.branchId, command.branchId))
          .run();

        // 8a. (removed) - no Backend Session Binding exists anymore

        // 9. Resolve effective model: walk from leaf to root, find last model_change.
        //    Synchronous DB query inside the transaction (no async port call).
        let effectiveModel = command.defaultModel;
        let walkId: string | null = parentId;
        while (walkId) {
          const entryRow = d
            .select()
            .from(schema.agentContextEntry)
            .where(eq(schema.agentContextEntry.entryId, walkId))
            .get();
          if (!entryRow) break;
          if (entryRow.type === "model_change") {
            const payload = JSON.parse(entryRow.payload) as { model: AgentRun["modelRef"] };
            effectiveModel = payload.model;
            break;
          }
          walkId = entryRow.parentId;
        }

        // 10. Create the active Agent Run
        const runId = deps.idGen.ulid();
        d.insert(schema.agentRun)
          .values({
            runId,
            branchId: command.branchId,
            conversationId: command.conversationId,
            agentId: command.agentId,
            modelRef: JSON.stringify(effectiveModel),
            status: "running",
            idempotencyKey: command.runIdempotencyKey,
            configRevision: command.configRevision,
            workspaceRoot: command.workspace?.root ?? null,
            workspaceAccess: command.workspace?.access ?? null,
            systemPrompt: command.systemPrompt ?? null,
            skillRoots: command.skillRoots ? JSON.stringify(command.skillRoots) : null,
            permissionMode: command.permissionMode ?? null,
            workflow: command.workflow ? JSON.stringify(command.workflow) : null,
            createdAt: now,
          })
          .run();

        // 11. Mark the input as delivering
        d.update(schema.branchInputQueue)
          .set({ status: "delivering", runId })
          .where(eq(schema.branchInputQueue.inputId, inputId))
          .run();

        const run = d.select().from(schema.agentRun).where(eq(schema.agentRun.runId, runId)).get()!;
        return {
          acquired: true,
          queued: false,
          replayed: false,
          run: parseRun(run),
          inputId,
        } satisfies AcquireAgentRunResult;
      });

      return txn();
    },
  };

  return method;
}
