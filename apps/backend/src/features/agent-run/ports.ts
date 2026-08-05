import type {
  BackendModelRef,
  BackendRunOutcome,
  PendingActionResponse,
  WorkspaceBinding,
} from "@my-agent-team/agent-backend";
import type { Message } from "@my-agent-team/message";
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
   *  branch when the branch is idle. Steer inputs are excluded: they belong
   *  to the run they were injected into and cannot be replayed as a new
   *  run's input. Returns null when nothing qualifies. */
  acquireNextRun(
    branchId: string,
    from: { modelRef: BackendModelRef; configRevision: number; workspace: WorkspaceBinding | null },
  ): Promise<AgentRun | null>;

  /** CAS an input from `delivering` to `delivered`. Duplicate acceptance
   *  returns the already-delivered row. */
  markInputAccepted(inputId: string): Promise<BranchInput>;

  /** CAS a specific queued input into `delivering` for a run (steer
   *  injection path). Returns null when the input is not pending. */
  deliverSteerInput(inputId: string, runId: string): Promise<BranchInput | null>;

  /** CAS a pending/delivering input to `cancelled` (a steer that lost its
   *  live Worker cannot be delivered later). */
  cancelInput(inputId: string): Promise<void>;

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
   *  and branch ownership, insert the final assistant Message into
   *  Conversation History, append its ledger_message ref to Agent Context,
   *  advance the branch leaf/revision/ledger cursor, and mark the Run
   *  completed - one backend.db transaction. Same runId replay returns the
   *  completed Run without rewriting anything. */
  commitCompletedRun(input: {
    runId: string;
    outcome: BackendRunOutcome;
    output: Message | undefined;
  }): Promise<AgentRun>;

  /** Mark a run commit_failed (Backend outcome arrived, Product transaction
   *  failed): store the outcome, keep the branch occupied, binding stale.
   *  Same runId replay returns the stored run. */
  failCommit(runId: string, outcome: BackendRunOutcome): Promise<AgentRun>;

  /** Persist the run's Product Tool manifest at first dispatch. */
  setRunProductTools(runId: string, manifest: readonly unknown[]): Promise<void>;

  /** All durable `delivering` inputs across branches (crash recovery). */
  listDeliveringInputs(): Promise<ClaimedBranchInput[]>;

  /** All commit_failed runs awaiting retryTerminalCommit. */
  listCommitFailedRuns(): Promise<AgentRun[]>;

  // ── Getters ───────────────────────────────────────────────────

  getRun(runId: string): Promise<AgentRun | null>;
  getActiveRun(branchId: string): Promise<AgentRun | null>;
  listInputs(branchId: string): Promise<BranchInput[]>;
  getPendingAction(actionId: string): Promise<PendingActionRecord | null>;
}
