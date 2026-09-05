import type {
  BackendEvent,
  BackendRegistry,
  BackendRunSegment,
  WorkspaceBinding,
} from "@chengchenccc/agent-contract";
import type { Message } from "@chengchenccc/message";
import type {
  AgentContextPort,
  IdGenerator,
  LedgerMessageResolver,
} from "../agent-context/ports.js";
import type { RunTokenRegistry } from "../product-tools/run-token-registry.js";
import type { WorkspaceLockRegistry } from "../project/workspace-lock.js";
import type { AgentRunPort } from "./ports.js";

export interface AgentRunExecutionDeps {
  readonly runPort: AgentRunPort;
  readonly contextPort: AgentContextPort;
  readonly ledgerResolver: LedgerMessageResolver;
  /** Per-kind dispatch table: `modelRef.backendKind` resolves the Backend
   *  and its catalog. Partial — a kind a deployment does not register gets
   *  a clear preflight error, never a silent fallback. */
  readonly backends: BackendRegistry;
  readonly idGen: IdGenerator;
  /** Wall-clock cap on a run (ms); the dispatch watchdog stops the
   *  backend and settles aborted on expiry. */
  readonly runTimeoutMs?: number;
  readonly resolveWorkspace: (input: {
    conversationId: string;
    agentId: string;
  }) => Promise<WorkspaceBinding>;
  /** Product Tools MCP endpoint the Oma child connects to
   *  (`sse:<url>`), from PRODUCT_TOOLS_MCP_URL. */
  readonly productToolsEntrypoint: string;
  /** Per-run product-tools bearer registry; minted at dispatch, revoked
   *  in dispatchFn's finally (every terminal path). */
  readonly productToolsTokenRegistry: RunTokenRegistry;
  /** Shared per-worktree lock (A4): run dispatch, loop clean-start/reset
   *  and agent detach serialize on the same roots. */
  readonly workspaceLocks: WorkspaceLockRegistry;
  /** Called after a completed run's Product commit (History Message +
   *  Context ref) lands atomically. Fired on the original commit AND on
   *  retryTerminalCommit replay - consumers must be idempotent per
   *  (runId, ...). Used by Conversation for the mention cascade. */
  readonly onRunCommitted?: (
    runId: string,
    output: Message | undefined,
    committedSeq: readonly number[],
  ) => void;
  /** Conversation title lookup for the auto-title retry flag. */
  readonly conversationTitleOf?: (conversationId: string) => string | null | undefined;
  /** Called after a failed/aborted/timeout run settles, so the surface can
   *  persist an assistant error message (T3-2: failures survive refresh).
   *  Fired once per terminal settle; consumers must be idempotent per runId. */
  readonly onRunFailed?: (input: {
    runId: string;
    conversationId: string;
    agentId: string;
    error: string;
  }) => void;
  /** Durable telemetry sink for normalized run events (tool calls, status,
   *  workflow steps). Wired to the RuntimeOps event store; failures are
   *  swallowed — telemetry never affects the run. */
  readonly persistRunEvent?: (runId: string, event: BackendEvent) => Promise<void>;
  /** Runtime MCP mount observation (backend.oma.mcp_mount_result). Wired to
   *  the MCP catalog's runtime-status store; absent = observation dropped. */
  readonly onMcpMountResult?: (input: {
    serverName: string;
    ok: boolean;
    toolsCount: number;
    error?: string;
    runId: string;
  }) => void;
}

export interface LiveRun {
  readonly segment: BackendRunSegment;
}

export interface AgentRunExecutionService {
  dispatch(runId: string): Promise<void>;
  /** Steer injection into the live run of a branch. Explicit failure (input
   *  cancelled) when no live run exists - never a silent conversion. */
  injectSteer(branchId: string, input: { inputId: string; message: Message }): Promise<void>;
  /** True when the run has a live in-process child (steer/abort routable).
   *  DB-active is NOT sufficient: after a restart or a pre-acceptance
   *  failure the Run row can be active with no live child (a zombie). */
  isLive(runId: string): boolean;
  /** True while the run's dispatch is in flight (pre-acceptance phases or
   *  settling) even without a live child yet. "owned" = isLive || isInflight;
   *  only a run that is neither is a true zombie. */
  isInflight(runId: string): boolean;
  /** Terminal a DB-active run that has NO live child (zombie): Run aborted,
   *  bound input cancelled, branch released. Only used by the auto-steer
   *  fallback; explicit steer never silently converts. */
  abortStaleRun(runId: string): Promise<void>;
  /** Shutdown: reject new dispatches, dispose the Backend (abort/SIGTERM/
   *  SIGKILL every child, awaiting their exit), then drain every in-flight
   *  dispatch so the DB is only closed after all terminal settles. */
  dispose(): Promise<void>;
  recover(): Promise<void>;
  retryTerminalCommit(runId: string): Promise<void>;
  stop(runId: string): Promise<void>;
  /** Resolve a pending HITL approval in the live run (spec: approval
   *  pipeline Phase B). Explicit failure when no live child exists. */
  resolveApproval(runId: string, callId: string, decision: "allow" | "deny"): Promise<void>;
  subscribe(runId: string, signal?: AbortSignal): AsyncIterable<BackendEvent>;
  /** Push a run-scoped event to the live SSE stream (web observes it). */
  broadcastRunEvent(runId: string, event: BackendEvent): void;
}
