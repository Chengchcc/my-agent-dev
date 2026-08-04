import type { Database } from "bun:sqlite";
import type { BackendRunOutcome } from "@my-agent-team/agent-backend";
import { and, eq, gt, inArray, not, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type {
  AgentContextPort,
  IdGenerator,
  LedgerMessageResolver,
} from "../agent-context/ports.js";
import {
  ACTIVE_RUN_STATUSES,
  type AcquireAgentRunCommand,
  type AcquireAgentRunResult,
  type AgentRun,
  AgentRunConflictError,
  type BranchInput,
  type ClaimedBranchInput,
  isTerminalStatus,
  PendingActionAlreadyConsumedError,
  type PendingActionRecord,
} from "./domain.js";
import type { AgentRunPort } from "./ports.js";

function parseModelRef(json: string): AgentRun["modelRef"] {
  return JSON.parse(json) as AgentRun["modelRef"];
}

function parseRun(row: typeof schema.agentRun.$inferSelect): AgentRun {
  return {
    runId: row.runId,
    branchId: row.branchId,
    conversationId: row.conversationId,
    agentMemberId: row.agentMemberId,
    modelRef: parseModelRef(row.modelRef),
    status: row.status as AgentRun["status"],
    idempotencyKey: row.idempotencyKey,
    terminalResult: row.terminalResult
      ? (JSON.parse(row.terminalResult) as BackendRunOutcome)
      : null,
    configRevision: row.configRevision,
    productTools: row.productTools
      ? (JSON.parse(row.productTools) as AgentRun["productTools"])
      : null,
    createdAt: row.createdAt,
    terminalAt: row.terminalAt,
  };
}

function parseInput(row: typeof schema.branchInputQueue.$inferSelect): BranchInput {
  return {
    inputId: row.inputId,
    branchId: row.branchId,
    mode: row.mode as BranchInput["mode"],
    message: JSON.parse(row.message) as BranchInput["message"],
    status: row.status as BranchInput["status"],
    deliveryIdempotencyKey: row.deliveryIdempotencyKey,
    inputIdempotencyKey: row.inputIdempotencyKey,
    runId: row.runId,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
  };
}

function parsePendingAction(row: typeof schema.pendingAction.$inferSelect): PendingActionRecord {
  return {
    actionId: row.actionId,
    runId: row.runId,
    kind: row.kind,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    status: row.status as PendingActionRecord["status"],
    response: row.response ? JSON.parse(row.response) : null,
    responseIdempotencyKey: row.responseIdempotencyKey,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

export interface AgentRunAdapterDeps {
  readonly contextPort: AgentContextPort;
  readonly ledgerResolver: LedgerMessageResolver;
  readonly idGen: IdGenerator;
}

export function sqliteAgentRunAdapter(db: Database, deps: AgentRunAdapterDeps): AgentRunPort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
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

        // 3. Validate command scope: branch must belong to the claimed
        //    conversation + agent member, and the default model must match
        //    the branch's backend kind.
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
          scopedBranch.agent_context_tree.agentMemberId !== command.agentMemberId ||
          scopedBranch.agent_context_branch.backendKind !== command.defaultModel.backendKind
        ) {
          throw new Error(
            `Scope mismatch: branch ${command.branchId} does not belong to (${command.conversationId}, ${command.agentMemberId}) or backend kind mismatch`,
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

        // 5. Filter by visibility: non-internal, broadcast or addressed to/sent by member.
        //    Must deserialize Message to check the visibility field.
        const eligible = ledgerEntries.filter((e) => {
          if (e.kind !== "message") return false;
          try {
            const message = JSON.parse(e.content) as { visibility?: string };
            if (message.visibility === "internal") return false;
          } catch {
            // Corrupt content: skip to avoid polluting context
            return false;
          }
          const addressedTo = JSON.parse(e.addressedTo) as string[];
          const isBroadcast = addressedTo.length === 0;
          const isAddressedTo = addressedTo.includes(command.agentMemberId);
          const isSentByMember = e.senderMemberId === command.agentMemberId;
          return isBroadcast || isAddressedTo || isSentByMember;
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

        // 8a. If context entries were appended, mark existing binding stale
        if (selected.length > 0) {
          d.update(schema.backendSessionBinding)
            .set({ state: "stale", updatedAt: now })
            .where(eq(schema.backendSessionBinding.branchId, command.branchId))
            .run();
        }
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
            agentMemberId: command.agentMemberId,
            modelRef: JSON.stringify(effectiveModel),
            status: "running",
            idempotencyKey: command.runIdempotencyKey,
            configRevision: command.configRevision,
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

    async claimNextInput(branchId: string): Promise<ClaimedBranchInput | null> {
      // First, check for an existing delivering row (crash recovery)
      const delivering = d
        .select()
        .from(schema.branchInputQueue)
        .where(
          and(
            eq(schema.branchInputQueue.branchId, branchId),
            eq(schema.branchInputQueue.status, "delivering"),
          ),
        )
        .orderBy(schema.branchInputQueue.createdAt, schema.branchInputQueue.inputId)
        .get();

      if (delivering) {
        const input = parseInput(delivering);
        if (input.runId) {
          return { input, runId: input.runId };
        }
      }

      // Get the active run for this branch
      const run = d
        .select()
        .from(schema.agentRun)
        .where(
          and(
            eq(schema.agentRun.branchId, branchId),
            inArray(schema.agentRun.status, [...ACTIVE_RUN_STATUSES]),
          ),
        )
        .get();

      if (!run) return null;

      // Atomic CAS: claim the oldest pending row in a single statement.
      // Updates only if status='pending', so concurrent callers cannot
      // claim the same input.
      const claimed = d
        .update(schema.branchInputQueue)
        .set({ status: "delivering", runId: run.runId })
        .where(
          and(
            eq(
              schema.branchInputQueue.inputId,
              sql`(SELECT input_id FROM branch_input_queue
                   WHERE branch_id=${branchId} AND status='pending'
                   ORDER BY created_at, input_id LIMIT 1)`,
            ),
            eq(schema.branchInputQueue.status, "pending"),
          ),
        )
        .returning()
        .get();

      if (!claimed) return null;

      return { input: parseInput(claimed), runId: run.runId };
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
    async consumePendingAction(actionId, response, responseIdempotencyKey) {
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
    async finalizeRun(runId, outcome) {
      if (outcome.status === "suspended") {
        throw new Error("suspended is not a terminal Agent Run status; use createPendingAction");
      }

      const row = d.select().from(schema.agentRun).where(eq(schema.agentRun.runId, runId)).get();

      if (!row) throw new Error(`Agent Run not found: ${runId}`);

      // Already terminal? Check for idempotent replay
      if (isTerminalStatus(row.status as AgentRun["status"])) {
        const stored = row.terminalResult
          ? (JSON.parse(row.terminalResult) as BackendRunOutcome)
          : null;
        if (stored && JSON.stringify(stored) === JSON.stringify(outcome)) {
          return parseRun(row);
        }
        throw new AgentRunConflictError(runId);
      }

      // Finalize: set terminal status + result
      const now = Date.now();
      const result = d
        .update(schema.agentRun)
        .set({
          status: outcome.status,
          terminalResult: JSON.stringify(outcome),
          terminalAt: now,
        })
        .where(
          and(
            eq(schema.agentRun.runId, runId),
            not(inArray(schema.agentRun.status, ["completed", "failed", "aborted", "timeout"])),
          ),
        )
        .returning()
        .get();

      if (!result) {
        throw new AgentRunConflictError(runId);
      }

      return parseRun(result);
    },

    async getRun(runId) {
      const row = d.select().from(schema.agentRun).where(eq(schema.agentRun.runId, runId)).get();
      return row ? parseRun(row) : null;
    },

    async commitCompletedRun({ runId, outcome, output, backendSessionId }) {
      if (outcome.status !== "completed") {
        throw new Error(`commitCompletedRun requires a completed outcome, got ${outcome.status}`);
      }
      const now = Date.now();
      return db.transaction(() => {
        const run = d.select().from(schema.agentRun).where(eq(schema.agentRun.runId, runId)).get();
        if (!run) throw new Error(`Agent Run not found: ${runId}`);

        // Idempotent replay: already completed -> return, never rewrite.
        if (run.status === "completed") return parseRun(run);

        // Only a running or commit_failed run may be committed.
        if (run.status !== "running" && run.status !== "commit_failed") {
          throw new AgentRunConflictError(runId);
        }

        // Branch ownership: the branch must belong to the run's conversation
        // + agent member.
        const branch = d
          .select()
          .from(schema.agentContextBranch)
          .where(eq(schema.agentContextBranch.branchId, run.branchId))
          .get();
        if (!branch) throw new Error(`Branch not found: ${run.branchId}`);
        const tree = d
          .select()
          .from(schema.agentContextTree)
          .where(eq(schema.agentContextTree.treeId, branch.treeId))
          .get();
        if (
          !tree ||
          tree.conversationId !== run.conversationId ||
          tree.agentMemberId !== run.agentMemberId
        ) {
          throw new AgentRunConflictError(runId);
        }

        let newRevision = branch.revision;
        let leafEntryId = branch.leafEntryId;

        // Insert the final assistant Message into Conversation History and
        // append its ledger_message ref to Agent Context. A completed run
        // without an output Message commits nothing to the ledger.
        if (output) {
          const seq = d
            .insert(schema.conversationLedger)
            .values({
              conversationId: run.conversationId,
              senderMemberId: run.agentMemberId,
              addressedTo: "[]",
              kind: "message",
              content: JSON.stringify(output),
              ts: now,
            })
            .returning({ seq: schema.conversationLedger.seq })
            .get();
          if (!seq) throw new Error("ledger insert returned no seq");

          const entryId = deps.idGen.ulid();
          d.insert(schema.agentContextEntry)
            .values({
              entryId,
              treeId: branch.treeId,
              parentId: leafEntryId,
              type: "ledger_message",
              payload: "{}",
              ledgerSeq: seq.seq,
              createdAt: now,
            })
            .run();

          newRevision = branch.revision + 1;
          leafEntryId = entryId;
          d.update(schema.agentContextBranch)
            .set({
              leafEntryId,
              ledgerCursor: seq.seq,
              revision: newRevision,
            })
            .where(eq(schema.agentContextBranch.branchId, run.branchId))
            .run();
        }

        // Sync the Backend Session Binding to the new leaf.
        d.insert(schema.backendSessionBinding)
          .values({
            branchId: run.branchId,
            backendSessionId,
            backendKind: branch.backendKind,
            syncedEntryId: leafEntryId,
            syncedRevision: newRevision,
            state: "active",
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: schema.backendSessionBinding.branchId,
            set: {
              backendSessionId,
              backendKind: branch.backendKind,
              syncedEntryId: leafEntryId,
              syncedRevision: newRevision,
              state: "active",
              updatedAt: now,
            },
          })
          .run();

        // Mark the Run completed.
        const updated = d
          .update(schema.agentRun)
          .set({
            status: "completed",
            terminalResult: JSON.stringify(outcome),
            terminalAt: now,
          })
          .where(eq(schema.agentRun.runId, runId))
          .returning()
          .get();
        if (!updated) throw new AgentRunConflictError(runId);
        return parseRun(updated);
      })();
    },

    async failCommit(runId, outcome) {
      const row = d.select().from(schema.agentRun).where(eq(schema.agentRun.runId, runId)).get();
      if (!row) throw new Error(`Agent Run not found: ${runId}`);
      if (isTerminalStatus(row.status as AgentRun["status"])) {
        const stored = row.terminalResult
          ? (JSON.parse(row.terminalResult) as BackendRunOutcome)
          : null;
        if (stored && JSON.stringify(stored) === JSON.stringify(outcome)) {
          return parseRun(row);
        }
        throw new AgentRunConflictError(runId);
      }
      const now = Date.now();
      const updated = d
        .update(schema.agentRun)
        .set({
          status: "commit_failed",
          terminalResult: JSON.stringify(outcome),
          terminalAt: now,
        })
        .where(and(eq(schema.agentRun.runId, runId), eq(schema.agentRun.status, "running")))
        .returning()
        .get();
      if (!updated) throw new AgentRunConflictError(runId);
      return parseRun(updated);
    },

    async setRunProductTools(runId, manifest) {
      d.update(schema.agentRun)
        .set({ productTools: JSON.stringify(manifest) })
        .where(eq(schema.agentRun.runId, runId))
        .run();
    },

    async listDeliveringInputs() {
      const rows = d
        .select()
        .from(schema.branchInputQueue)
        .where(eq(schema.branchInputQueue.status, "delivering"))
        .orderBy(schema.branchInputQueue.createdAt, schema.branchInputQueue.inputId)
        .all();
      return rows
        .filter((r) => r.runId != null)
        .map((r) => ({ input: parseInput(r), runId: r.runId! }));
    },

    async listCommitFailedRuns() {
      const rows = d
        .select()
        .from(schema.agentRun)
        .where(eq(schema.agentRun.status, "commit_failed"))
        .all();
      return rows.map(parseRun);
    },

    async getActiveRun(branchId) {
      const row = d
        .select()
        .from(schema.agentRun)
        .where(
          and(
            eq(schema.agentRun.branchId, branchId),
            inArray(schema.agentRun.status, [...ACTIVE_RUN_STATUSES]),
          ),
        )
        .get();
      return row ? parseRun(row) : null;
    },

    async listInputs(branchId) {
      const rows = d
        .select()
        .from(schema.branchInputQueue)
        .where(eq(schema.branchInputQueue.branchId, branchId))
        .orderBy(schema.branchInputQueue.createdAt, schema.branchInputQueue.inputId)
        .all();
      return rows.map(parseInput);
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
