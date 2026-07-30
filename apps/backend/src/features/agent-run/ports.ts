import type { BackendRunOutcome, PendingActionResponse } from "@my-agent-team/agent-backend";
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

  /** Claim the next input to deliver. Returns an existing `delivering` row
   *  first (crash recovery), then the oldest `pending` row. */
  claimNextInput(branchId: string): Promise<ClaimedBranchInput | null>;

  /** CAS an input from `delivering` to `delivered`. Duplicate acceptance
   *  returns the already-delivered row. */
  markInputAccepted(inputId: string): Promise<BranchInput>;

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

  // ── Getters ───────────────────────────────────────────────────

  getRun(runId: string): Promise<AgentRun | null>;
  getActiveRun(branchId: string): Promise<AgentRun | null>;
  listInputs(branchId: string): Promise<BranchInput[]>;
  getPendingAction(actionId: string): Promise<PendingActionRecord | null>;
}
