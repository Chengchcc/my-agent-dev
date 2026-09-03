import type { Database } from "bun:sqlite";
import type { BackendRunOutcome } from "@chengchenccc/agent-contract";
import {
  assistantMessageId,
  type MessageRevision,
  MessageRevisionSchema,
  normalizeCanonicalMessages,
  serializeMessageRevision,
} from "@chengchenccc/message";
import { and, desc, eq, inArray, isNull, not, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type { IdGenerator } from "../agent-context/ports.js";
import { parseInput, parseRun } from "./adapter-sqlite-parse.js";
import {
  ACTIVE_RUN_STATUSES,
  type AgentRun,
  AgentRunConflictError,
  isTerminalStatus,
} from "./domain.js";
import type { AgentRunPort } from "./ports.js";

type RunMethods = Pick<
  AgentRunPort,
  | "acquireNextRun"
  | "finalizeRun"
  | "getRun"
  | "commitCompletedRun"
  | "failCommit"
  | "setRunProductTools"
  | "setRunTodoSnapshot"
  | "getLatestRunTodo"
  | "listCommitFailedRuns"
  | "listActiveRunsWithDeliveredInputs"
  | "hasActiveRunForConversations"
  | "listActiveRunsForConversations"
  | "getActiveRun"
>;

export function createRunMethods(
  db: Database,
  deps: { idGen: IdGenerator; commitTestHook?: () => void },
): RunMethods {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    /** One Run / one input: promote the oldest still-unowned queued input
     *  (run_id IS NULL) into a FRESH Run when the branch is idle. The new
     *  Run is built from the queued input's OWN config snapshot - never
     *  reuses the settled run's config (model/workspace/systemPrompt/
     *  skillRoots are request-time facts of the input). Never reuses the
     *  settled run's id - the child rejects a second segment for an
     *  already-settled runId. */
    async acquireNextRun(branchId: string): Promise<AgentRun | null> {
      const txn = db.transaction(() => {
        const now = Date.now();
        // Branch must be idle: an active run (or commit_failed) still owns it.
        const active = d
          .select()
          .from(schema.agentRun)
          .where(
            and(
              eq(schema.agentRun.branchId, branchId),
              inArray(schema.agentRun.status, [...ACTIVE_RUN_STATUSES]),
            ),
          )
          .get();
        if (active) return null;

        const branch = d
          .select()
          .from(schema.agentContextBranch)
          .where(eq(schema.agentContextBranch.branchId, branchId))
          .get();
        if (!branch) return null;

        // Oldest queued NON-STEER input not yet owned by any run.
        const input = d
          .select()
          .from(schema.branchInputQueue)
          .where(
            and(
              eq(schema.branchInputQueue.branchId, branchId),
              eq(schema.branchInputQueue.status, "pending"),
              isNull(schema.branchInputQueue.runId),
              not(eq(schema.branchInputQueue.mode, "steer")),
            ),
          )
          .orderBy(schema.branchInputQueue.seq)
          .get();
        if (!input) return null;

        // One revision bump per new run (matching acquire); CAS guards
        // concurrent chainers.
        const cas = d
          .update(schema.agentContextBranch)
          .set({ revision: branch.revision + 1 })
          .where(
            and(
              eq(schema.agentContextBranch.branchId, branchId),
              eq(schema.agentContextBranch.revision, branch.revision),
            ),
          )
          .returning()
          .get();
        if (!cas) return null;

        const tree = d
          .select()
          .from(schema.agentContextTree)
          .where(eq(schema.agentContextTree.treeId, branch.treeId))
          .get();
        const snapshot = parseInput(input).configSnapshot;
        const runId = deps.idGen.ulid();
        const conv = tree
          ? d
              .select({ agentId: schema.conversation.agentId })
              .from(schema.conversation)
              .where(eq(schema.conversation.conversationId, tree.conversationId))
              .get()
          : undefined;
        d.insert(schema.agentRun)
          .values({
            runId,
            branchId,
            conversationId: tree?.conversationId ?? "",
            agentId: conv?.agentId ?? "",
            modelRef: JSON.stringify(snapshot.modelRef),
            status: "running",
            idempotencyKey: `${input.inputIdempotencyKey}:run`,
            configRevision: snapshot.configRevision,
            workspaceRoot: snapshot.workspace?.root ?? null,
            workspaceAccess: snapshot.workspace?.access ?? null,
            systemPrompt: snapshot.systemPrompt ?? null,
            skillRoots: snapshot.skillRoots ? JSON.stringify(snapshot.skillRoots) : null,
            permissionMode: snapshot.permissionMode ?? null,
            workflowBudgetTokens: snapshot.workflowBudgetTokens ?? null,
            createdAt: now,
          })
          .run();
        d.update(schema.branchInputQueue)
          .set({ status: "delivering", runId })
          .where(eq(schema.branchInputQueue.inputId, input.inputId))
          .run();
        const run = d.select().from(schema.agentRun).where(eq(schema.agentRun.runId, runId)).get()!;
        return parseRun(run);
      });
      return txn();
    },

    async finalizeRun(runId, outcome: BackendRunOutcome): Promise<AgentRun> {
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

    async commitCompletedRun({
      runId,
      outcome,
      messages,
    }: Parameters<AgentRunPort["commitCompletedRun"]>[0]) {
      if (outcome.status !== "completed") {
        throw new Error(`commitCompletedRun requires a completed outcome, got ${outcome.status}`);
      }
      const now = Date.now();
      return db.transaction(() => {
        const run = d.select().from(schema.agentRun).where(eq(schema.agentRun.runId, runId)).get();
        if (!run) throw new Error(`Agent Run not found: ${runId}`);

        // Idempotent replay: already completed -> return, never rewrite.
        if (run.status === "completed") return { run: parseRun(run), seqs: [] };

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
        if (!tree || tree.conversationId !== run.conversationId) {
          throw new AgentRunConflictError(runId);
        }

        // Boundary enforcement (ADR 0017): the Run's output must be a
        // canonical message sequence — assistant never carries tool_result.
        // normalizeCanonicalMessages is the single normalization point for
        // any oma type; a completed run with no messages commits
        // nothing to the ledger.
        const canonical = normalizeCanonicalMessages(messages ?? []);

        // Commit each canonical message as its own ledger row, keyed by
        // (agent_run_id, message_index). The pair is the COMMIT IDENTITY:
        // concurrent commits (parallel retries, restart, second instance)
        // can never write a message twice — the second writer reuses the
        // first seq. The whole batch is one atomic transaction with one
        // branch revision bump; a crash mid-batch either left no CAS (replay
        // appends the missing refs and CASes) or completed the CAS (replay
        // finds every ref and skips).
        let parentId = branch.leafEntryId;
        const seqs: number[] = [];
        let lastSeq: number | null = null;
        // Assistant ordinals run in REVERSE: the final assistant message is
        // `run:<runId>:assistant:0` — the web's transient bubble waits for
        // exactly that id to be replaced by the canonical final answer.
        const assistantCount = canonical.filter((m) => m.role === "assistant").length;
        let assistantSeen = 0;
        let appendedRefs = 0;
        for (let index = 0; index < canonical.length; index++) {
          const message = canonical[index]!;
          // The canonical assistant Message MUST satisfy the MessageRevision
          // contract (messageId/state/updatedAt) that every surface parser
          // (Web reducer, Lark watcher) enforces. The raw output message is
          // stamped with the terminal fields here — the single place a Run's
          // messages are written. messageId derives from the runId (Product
          // Run identity), NOT from the agent output.
          const messageId =
            message.role === "assistant"
              ? assistantMessageId(runId, assistantCount - 1 - assistantSeen++)
              : `run:${runId}:tool:${index}`;
          const revision = MessageRevisionSchema.parse({
            messageId,
            role: message.role,
            state: "done",
            text: message.text ?? undefined,
            blocks: message.blocks,
            tools: message.tools,
            conversationId: run.conversationId,
            visibility: message.visibility ?? "conversation",
            updatedAt: now,
          }) as MessageRevision;
          const inserted = d
            .insert(schema.conversationLedger)
            .values({
              conversationId: run.conversationId,
              senderMemberId: run.agentId,
              addressedTo: "[]",
              kind: "message",
              content: serializeMessageRevision(revision),
              ts: now,
              agentRunId: runId,
              messageIndex: index,
            })
            // ON CONFLICT DO NOTHING (no target): the identity is the
            // partial UNIQUE index on (agent_run_id, message_index), which
            // SQLite cannot use as an UPSERT target - a conflicting insert
            // is simply a no-op and the seq below is re-read.
            .onConflictDoNothing()
            .returning({ seq: schema.conversationLedger.seq })
            .get();
          const seq =
            inserted?.seq ??
            d
              .select({ seq: schema.conversationLedger.seq })
              .from(schema.conversationLedger)
              .where(
                and(
                  eq(schema.conversationLedger.agentRunId, runId),
                  eq(schema.conversationLedger.messageIndex, index),
                ),
              )
              .get()?.seq;
          if (!seq) throw new Error("ledger insert returned no seq");
          seqs.push(seq);
          lastSeq = seq;

          // Context ref is deduped by (treeId, ledgerSeq): a crash between
          // the ledger insert and the ref append leaves no duplicate ref on
          // retry. The ref chain continues from the previous committed
          // message's ref (or the branch leaf on a fresh commit).
          const existingRef = d
            .select()
            .from(schema.agentContextEntry)
            .where(
              and(
                eq(schema.agentContextEntry.treeId, branch.treeId),
                eq(schema.agentContextEntry.type, "ledger_message"),
                eq(schema.agentContextEntry.ledgerSeq, seq),
              ),
            )
            .get();
          if (existingRef) {
            parentId = existingRef.entryId;
          } else {
            const entryId = deps.idGen.ulid();
            d.insert(schema.agentContextEntry)
              .values({
                entryId,
                treeId: branch.treeId,
                parentId,
                type: "ledger_message",
                payload: "{}",
                ledgerSeq: seq,
                createdAt: now,
              })
              .run();
            parentId = entryId;
            appendedRefs++;
          }
        }

        // CAS the branch revision ONCE for the whole batch: a concurrent
        // history_retain (late MCP call, timeout recovery, cross-process
        // retry) must not clobber or be clobbered by this commit's
        // leaf/revision update. On conflict the WHOLE transaction rolls back
        // and the commit retry re-reads the branch. A replay that appended
        // no refs skips the CAS (the first attempt already advanced it).
        if (appendedRefs > 0 && lastSeq !== null) {
          const cas = d
            .update(schema.agentContextBranch)
            .set({
              leafEntryId: parentId,
              ledgerCursor: lastSeq,
              revision: branch.revision + 1,
            })
            .where(
              and(
                eq(schema.agentContextBranch.branchId, run.branchId),
                eq(schema.agentContextBranch.revision, branch.revision),
              ),
            )
            .returning({ branchId: schema.agentContextBranch.branchId })
            .get();
          if (!cas) {
            throw new Error(`branch ${run.branchId} revision conflict during terminal commit`);
          }
        }

        // Test-only fault injection point: a throw here must roll back the
        // ledger inserts, the context refs, and the branch update together.
        deps.commitTestHook?.();

        // Mark the Run completed (CAS on the active statuses so a racing
        // finalizer cannot double-transition).
        const updated = d
          .update(schema.agentRun)
          .set({
            status: "completed",
            terminalResult: JSON.stringify(outcome),
            terminalAt: now,
          })
          .where(
            and(
              eq(schema.agentRun.runId, runId),
              inArray(schema.agentRun.status, ["running", "commit_failed"]),
            ),
          )
          .returning()
          .get();
        if (!updated) throw new AgentRunConflictError(runId);
        return { run: parseRun(updated), seqs };
      })();
    },

    async failCommit(runId, outcome: BackendRunOutcome): Promise<AgentRun> {
      // The Run transitions running -> commit_failed in ONE transaction: the
      // branch stays occupied while the terminal Product commit is
      // unrecoverable-yet (recoverable only via retryTerminalCommit).
      return db.transaction(() => {
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
      })();
    },

    async setRunProductTools(runId, manifest) {
      const json = JSON.stringify(manifest);
      // Write-once: the run snapshot is frozen at first dispatch. A replay
      // with the same manifest is a no-op; a different manifest conflicts; a
      // missing run errors.
      const updated = d
        .update(schema.agentRun)
        .set({ productTools: json })
        .where(and(eq(schema.agentRun.runId, runId), sql`${schema.agentRun.productTools} IS NULL`))
        .returning({ runId: schema.agentRun.runId })
        .get();
      if (updated) return;
      const existing = d
        .select({ productTools: schema.agentRun.productTools })
        .from(schema.agentRun)
        .where(eq(schema.agentRun.runId, runId))
        .get();
      if (!existing) throw new Error(`Agent Run not found: ${runId}`);
      if (existing.productTools !== json) {
        throw new Error(
          `Product Tool manifest for run ${runId} is frozen; a different manifest is a conflict`,
        );
      }
    },

    async setRunTodoSnapshot(runId, snapshot) {
      const updated = d
        .update(schema.agentRun)
        .set({ todoSnapshot: snapshot })
        .where(eq(schema.agentRun.runId, runId))
        .returning({ runId: schema.agentRun.runId })
        .get();
      if (!updated) throw new Error(`Agent Run not found: ${runId}`);
    },

    async getLatestRunTodo(branchId) {
      const row = d
        .select({ todoSnapshot: schema.agentRun.todoSnapshot })
        .from(schema.agentRun)
        .where(
          and(
            eq(schema.agentRun.branchId, branchId),
            sql`${schema.agentRun.todoSnapshot} IS NOT NULL`,
          ),
        )
        .orderBy(desc(schema.agentRun.createdAt))
        .limit(1)
        .get();
      return row?.todoSnapshot ?? null;
    },

    async listCommitFailedRuns() {
      const rows = d
        .select()
        .from(schema.agentRun)
        .where(eq(schema.agentRun.status, "commit_failed"))
        .all();
      return rows.map(parseRun);
    },

    async listActiveRunsWithDeliveredInputs() {
      const rows = d
        .selectDistinct({ run: schema.agentRun })
        .from(schema.agentRun)
        .innerJoin(
          schema.branchInputQueue,
          and(
            eq(schema.branchInputQueue.runId, schema.agentRun.runId),
            eq(schema.branchInputQueue.status, "delivered"),
          ),
        )
        .where(inArray(schema.agentRun.status, ["running", "waiting", "commit_failed"]))
        .all();
      return rows.map((r) => parseRun(r.run));
    },

    async hasActiveRunForConversations(conversationIds) {
      if (conversationIds.length === 0) return false;
      const rows = d
        .select({ runId: schema.agentRun.runId })
        .from(schema.agentRun)
        .where(
          and(
            inArray(schema.agentRun.conversationId, [...conversationIds]),
            inArray(schema.agentRun.status, ["running", "waiting", "commit_failed"]),
          ),
        )
        .limit(1)
        .all();
      return rows.length > 0;
    },

    async listActiveRunsForConversations(conversationIds) {
      if (conversationIds.length === 0) return [];
      const rows = d
        .select()
        .from(schema.agentRun)
        .where(
          and(
            inArray(schema.agentRun.conversationId, [...conversationIds]),
            inArray(schema.agentRun.status, [...ACTIVE_RUN_STATUSES]),
          ),
        )
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
  };
}
