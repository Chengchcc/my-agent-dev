import type {
  BackendModelRef,
  BackendRunOutcome,
  WorkspaceBinding,
} from "@chengchenccc/agent-backend";
import type { Message } from "@chengchenccc/message";

// ─── Agent Run status ────────────────────────────────────────────

export type AgentRunStatus =
  | "running"
  | "waiting"
  | "commit_failed"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout";

/** Active statuses that occupy the branch's single active-run slot. */
export const ACTIVE_RUN_STATUSES = ["running", "waiting", "commit_failed"] as const;

/** Terminal statuses that release the active-run slot. */
export const TERMINAL_RUN_STATUSES = ["completed", "failed", "aborted", "timeout"] as const;

export function isTerminalStatus(status: AgentRunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export function isActiveStatus(status: AgentRunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

// ─── Agent Run entity ────────────────────────────────────────────

export interface AgentRun {
  readonly runId: string;
  readonly branchId: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly modelRef: BackendModelRef;
  readonly status: AgentRunStatus;
  readonly idempotencyKey: string;
  readonly terminalResult: BackendRunOutcome | null;
  readonly configRevision: number;
  /** Run-level workspace snapshot (set by callers that bind a specific
   *  workspace, e.g. Loop's cloned repo); null = agent-record default. */
  readonly workspace: { root: string; access: "read_only" | "read_write" } | null;
  /** Product Tool manifest (ProductToolDescriptor[]), persisted at first
   *  dispatch; Product Tools MCP validates calls against it. */
  readonly productTools:
    | readonly { name: string; description: string; inputSchema: unknown; entrypoint: string }[]
    | null;
  /** Frozen system prompt (Agent identity / LOOP.md prompt), persisted at
   *  Run creation; dispatch never re-resolves it. */
  readonly systemPrompt: string | null;
  /** Frozen skill pack roots, persisted at Run creation. */
  readonly skillRoots: readonly string[] | null;
  /** Frozen permission_mode (ADR 0020 decision 7), mapped per backend at
   *  dispatch. */
  readonly permissionMode: string | null;
  /** JSON: latest task list snapshot (todo_write product tool). */
  readonly todoSnapshot: string | null;
  /** Optional workflow budget (tokens), frozen at Run creation. */
  readonly workflowBudgetTokens: number | null;
  /** Oma workflow-mode input ({ script, args? }); Loop items execute a
   *  script directly instead of an interactive loop. */
  readonly workflow: { readonly script: string; readonly args?: unknown } | null;
  readonly createdAt: number;
  readonly terminalAt: number | null;
}

// ─── Branch Input Queue ──────────────────────────────────────────

export type BranchInputMode = "normal" | "steer" | "follow_up";

export type BranchInputStatus = "pending" | "delivering" | "delivered" | "cancelled";

export interface BranchInput {
  readonly inputId: string;
  /** Monotonic queue sequence (insertion order), the stable sort key. */
  readonly seq: number;
  readonly branchId: string;
  readonly mode: BranchInputMode;
  readonly message: Message;
  readonly status: BranchInputStatus;
  readonly deliveryIdempotencyKey: string;
  readonly inputIdempotencyKey: string;
  readonly runId: string | null;
  /** Request-time Run config snapshot: what THIS input asked for. Used by
   *  acquireNextRun to promote the input into a Run with its OWN config
   *  (model/workspace/systemPrompt/skillRoots), never the previous Run's. */
  readonly configSnapshot: {
    readonly modelRef: { backendKind: string; modelId: string };
    readonly configRevision: number;
    readonly workspace: { root: string; access: "read_only" | "read_write" } | null;
    readonly systemPrompt: string | null;
    readonly skillRoots: readonly string[] | null;
    readonly permissionMode: string | null;
    readonly workflowBudgetTokens: number | null;
  };
  readonly createdAt: number;
  readonly deliveredAt: number | null;
}

// ─── Pending Action ──────────────────────────────────────────────

export type PendingActionStatus = "pending" | "resolved" | "cancelled";

export interface PendingActionRecord {
  readonly actionId: string;
  readonly runId: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status: PendingActionStatus;
  readonly response: unknown | null;
  readonly responseIdempotencyKey: string | null;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
}

// ─── Commands ────────────────────────────────────────────────────

export interface AcquireAgentRunCommand {
  readonly conversationId: string;
  readonly agentId: string;
  readonly branchId: string;
  readonly mode: BranchInputMode;
  readonly message: Message;
  readonly inputIdempotencyKey: string;
  readonly runIdempotencyKey: string;
  readonly deliveryIdempotencyKey: string;
  readonly defaultModel: BackendModelRef;
  readonly configRevision: number;
  readonly expectedRevision: number;
  /** Optional run-level workspace snapshot; null = agent-record default. */
  readonly workspace?: WorkspaceBinding;
  /** Frozen system prompt for the Run (Agent identity for Conversation/Cron;
   *  LOOP.md prompt for Loop scopes). Default: resolved by the service's
   *  resolveRunConfig when provided. */
  readonly systemPrompt?: string;
  /** Frozen skill pack roots for the Run. Default: resolved by the service's
   *  resolveRunConfig when provided. */
  readonly skillRoots?: readonly string[];
  /** Frozen permission_mode (ADR 0020 decision 7). */
  readonly permissionMode?: string;
  /** Optional workflow budget (tokens) for this Run; null = no gate. */
  readonly workflowBudgetTokens?: number;
  /** Oma workflow-mode input: execute this script instead of a loop. */
  readonly workflow?: { readonly script: string; readonly args?: unknown };
}
export interface AcquireAgentRunResult {
  readonly acquired: boolean;
  readonly queued: boolean;
  readonly replayed: boolean;
  /** True when the input was cancelled at enqueue (a steer with no active
   *  Run). No run was created; the caller surfaces the explicit failure. */
  readonly cancelled?: boolean;
  readonly run?: AgentRun;
  readonly inputId: string;
}

export interface ClaimedBranchInput {
  readonly input: BranchInput;
  readonly runId: string;
}

// ─── Errors ──────────────────────────────────────────────────────

export class BranchAlreadyActiveError extends Error {
  constructor(readonly branchId: string) {
    super(`Branch ${branchId} already has an active Agent Run`);
    this.name = "BranchAlreadyActiveError";
  }
}

export class AgentRunConflictError extends Error {
  constructor(readonly runId: string) {
    super(`Agent Run ${runId} conflict: terminal outcome mismatch`);
    this.name = "AgentRunConflictError";
  }
}

export class PendingActionAlreadyConsumedError extends Error {
  constructor(readonly actionId: string) {
    super(`PendingAction ${actionId} already consumed with a different response`);
    this.name = "PendingActionAlreadyConsumedError";
  }
}
