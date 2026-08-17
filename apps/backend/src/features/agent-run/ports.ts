import type { BackendRunOutcome, PendingActionResponse } from "@chengchenccc/agent-backend";
import type { Message } from "@chengchenccc/message";
import type {
  AcquireAgentRunCommand,
  AcquireAgentRunResult,
  AgentRun,
  BranchInput,
  ClaimedBranchInput,
  PendingActionRecord,
} from "./domain.js";

/** Storage port for Agent Run, queue, and PendingAction persistence. */
export interface AgentRunPort {
  /** Atomically enqueue an input and try to acquire the branch for a Run.
   *  If the branch is already active, the input is queued and no Context
   *  mutation occurs. */
  enqueueAndAcquire(command: AcquireAgentRunCommand): Promise<AcquireAgentRunResult>;

  /** Claim the input already bound to a run (run_id = ?). One Run / one
   *  input: a run NEVER claims inputs bound to another run. */
  claimInputForRun(runId: string): Promise<ClaimedBranchInput | null>;

  /** One Run / one input: after a run settles, promote the oldest still-
   *  queued NON-STEER input (run_id IS NULL) into a FRESH Run on the same
   *  branch when the branch is idle. The new Run is built from the queued
   *  input's OWN config snapshot - never from the settled run's config.
   *  Steer inputs are excluded: they belong to the run they were injected
   *  into and cannot be replayed as a new run's input. Returns null when
   *  nothing qualifies. */
  acquireNextRun(branchId: string): Promise<AgentRun | null>;

  /** CAS an input from `delivering` to `delivered`. Duplicate acceptance
   *  returns the already-delivered row. */
  markInputAccepted(inputId: string): Promise<BranchInput>;

  /** CAS a specific queued input into `delivering` for a run (steer
   *  injection path). Returns null when the input is not pending. */
  deliverSteerInput(inputId: string, runId: string): Promise<BranchInput | null>;

  /** CAS a pending/delivering input to `cancelled` (a steer that lost its
   *  live Worker cannot be delivered later). */
  cancelInput(inputId: string): Promise<void>;

  /** Cancel every pending/delivering input bound to a Run (permanent
   *  dispatch failure path: the Run is finalized failed, its input must
   *  not linger as a phantom delivering row). */
  cancelRunInput(runId: string): Promise<void>;

  /** Create a PendingAction and set the Run to `waiting`. */
  createPendingAction(
    runId: string,
    action: { actionId: string; kind: string; payload: Readonly<Record<string, unknown>> },
  ): Promise<PendingActionRecord>;

  /** Consume a PendingAction response once. Same idempotency key returns
   *  stored result; conflicting response throws. */
  consumePendingAction(
    actionId: string,
    response: PendingActionResponse,
    responseIdempotencyKey: string,
  ): Promise<{ action: PendingActionRecord; runId: string }>;

  /** Finalize a Run with a terminal outcome. Same runId replay returns
   *  stored result; conflicting outcome fails. */
  finalizeRun(runId: string, outcome: BackendRunOutcome): Promise<AgentRun>;

  /** Atomically commit a COMPLETED run: verify the run is running/commit_failed
   *  and branch ownership, insert the Run's canonical message sequence into
   *  Conversation History (one ledger row per message, keyed by
   *  (agent_run_id, message_index)), append their ledger_message refs to
   *  Agent Context, advance the branch leaf/revision/ledger cursor, and mark
   *  the Run completed - one backend.db transaction. Same (runId,
   *  message_index) replay returns the completed Run without rewriting. */
  commitCompletedRun(input: {
    runId: string;
    outcome: BackendRunOutcome;
    messages: readonly Message[];
  }): Promise<AgentRun>;

  /** Mark a run commit_failed (Backend outcome arrived, Product transaction
   *  failed): store the outcome, keep the branch occupied, binding stale.
   *  Same runId replay returns the stored run. */
  failCommit(runId: string, outcome: BackendRunOutcome): Promise<AgentRun>;

  /** Persist the run's Product Tool manifest at first dispatch. */
  setRunProductTools(runId: string, manifest: readonly unknown[]): Promise<void>;
  /** Persist the run's latest task list snapshot (todo_write). */
  setRunTodoSnapshot(runId: string, snapshot: string): Promise<void>;
  /** The branch's most recent non-null todo snapshot (re-injected into the
   *  next run's prompt). Null = the branch never wrote one. */
  getLatestRunTodo(branchId: string): Promise<string | null>;

  /** All durable `delivering` inputs across branches (crash recovery). */
  listDeliveringInputs(): Promise<ClaimedBranchInput[]>;

  /** Branch ids with a pending non-steer input (run_id IS NULL), ordered by
   *  oldest pending input (FIFO). Crash-gap recovery: after a restart these
   *  inputs never became Runs; each branch is promoted via acquireNextRun.
   *  The active-run check happens inside acquireNextRun's transaction. */
  listIdleBranchesWithPendingInputs(): Promise<string[]>;

  /** All commit_failed runs awaiting retryTerminalCommit. */
  listCommitFailedRuns(): Promise<AgentRun[]>;

  /** Active runs whose bound input was DELIVERED (the child accepted) but
   *  whose live child no longer exists (Backend restart). One-shot-child
   *  architecture cannot resume them: boot recovery terminalizes them and
   *  releases the branch. */
  listActiveRunsWithDeliveredInputs(): Promise<AgentRun[]>;

  // ── Getters ───────────────────────────────────────────────────

  getRun(runId: string): Promise<AgentRun | null>;
  getActiveRun(branchId: string): Promise<AgentRun | null>;
  /** Whether any conversation in the set has an active Run (running /
   *  waiting / commit_failed). Loop delete uses it to reject deletion
   *  while its generator/evaluator scopes are live. */
  hasActiveRunForConversations(conversationIds: readonly string[]): Promise<boolean>;
  /** Whether any conversation in the set has an active Run (running /
   *  waiting / commit_failed). Used by Loop delete to reject deletion
   *  while its generator/evaluator scopes are live. */
  hasActiveRunForConversations(conversationIds: readonly string[]): Promise<boolean>;
  listInputs(branchId: string): Promise<BranchInput[]>;
  getPendingAction(actionId: string): Promise<PendingActionRecord | null>;
}
