import type {
  AgentBackend,
  BackendEvent,
  BackendModelRef,
  BackendRegistry,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
  ProjectedHistoryItem,
  WorkspaceBinding,
} from "@my-agent-team/agent-backend";
import { BACKEND_KINDS, type BackendKind, debugLog } from "@my-agent-team/agent-backend";
import { resolveModelAlias } from "@my-agent-team/ai";
import type { Message } from "@my-agent-team/message";
import type {
  AgentContextPort,
  IdGenerator,
  LedgerMessageResolver,
} from "../agent-context/ports.js";
import { projectAgentContext } from "../agent-context/projection.js";
import { buildHistoryTools } from "../product-tools/manifest.js";
import type { RunTokenRegistry } from "../product-tools/run-token-registry.js";
import type { AgentRun, BranchInput, ClaimedBranchInput } from "./domain.js";
import { isActiveStatus, isTerminalStatus } from "./domain.js";
import type { AgentRunPort } from "./ports.js";

/** The final answer of a canonical run sequence (ADR 0017): the last
 *  assistant message carrying text. Used for mention cascade and surface
 *  display; returns undefined when the run produced no final text. */
function finalAnswerMessage(messages: readonly Message[] | undefined): Message | undefined {
  return [...(messages ?? [])]
    .reverse()
    .find((m) => m.role === "assistant" && (m.text?.trim() ?? "") !== "");
}

// ─── Execution service ───────────────────────────────────────────────

export interface AgentRunExecutionDeps {
  readonly runPort: AgentRunPort;
  readonly contextPort: AgentContextPort;
  readonly ledgerResolver: LedgerMessageResolver;
  /** Per-kind dispatch table: `modelRef.backendKind` resolves the Backend
   *  and its catalog. Partial — a kind a deployment does not register gets
   *  a clear preflight error, never a silent fallback. */
  readonly backends: BackendRegistry;
  readonly idGen: IdGenerator;
  /** Resolve the workspace binding for a run's agent member (from the
   *  Agent's workspace path + permission mode; injected so tests and callers
   *  can vary it). Used ONLY when the Run itself did not pin a workspace
   *  snapshot. */
  /** Wall-clock cap on a run (ms); the dispatch watchdog stops the
   *  backend and settles aborted on expiry. */
  readonly runTimeoutMs?: number;
  readonly resolveWorkspace: (input: {
    conversationId: string;
    agentMemberId: string;
  }) => Promise<WorkspaceBinding>;
  /** Product Tools MCP endpoint the Coding Agent child connects to
   *  (`sse:<url>`), from PRODUCT_TOOLS_MCP_URL. */
  readonly productToolsEntrypoint: string;
  /** Per-run product-tools bearer registry; minted at dispatch, revoked
   *  in dispatchFn's finally (every terminal path). */
  readonly productToolsTokenRegistry: RunTokenRegistry;
  /** Called after a completed run's Product commit (History Message +
   *  Context ref) lands atomically. Fired on the original commit AND on
   *  retryTerminalCommit replay - consumers must be idempotent per
   *  (runId, ...). Used by Conversation for the mention cascade. */
  readonly onRunCommitted?: (runId: string, output: Message | undefined) => void;
}

interface LiveRun {
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
  subscribe(runId: string, signal?: AbortSignal): AsyncIterable<BackendEvent>;
}

/** Late-subscription handling for GET /agent-runs/:runId/events.
 *  - settled/unknown run: one terminal status event, then close (never a
 *    permanently open SSE for a run nothing will close);
 *  - commit_failed: the outcome is stored and the child is gone - report a
 *    terminal status WITHOUT touching the Product Run (retryTerminalCommit
 *    owns it); aborting here would conflict with the stored outcome;
 *  - active + live child OR dispatch in flight (pre-acceptance): subscribe
 *    to transient events - an inflight run must NEVER be aborted;
 *  - active, neither live nor inflight (true zombie): terminalize first,
 *    then a terminal status + close so the UI never shows a permanent
 *    Running state. */
export function runEventStreamFor(
  run: Pick<AgentRun, "status"> | null,
  execution: {
    isLive(runId: string): boolean;
    isInflight(runId: string): boolean;
    abortStaleRun(runId: string): Promise<void>;
    subscribe(runId: string, signal?: AbortSignal): AsyncIterable<BackendEvent>;
  },
  runId: string,
  signal?: AbortSignal,
): AsyncIterable<BackendEvent> {
  const terminal = (status: string): AsyncIterable<BackendEvent> =>
    (async function* () {
      yield { type: "status", status };
    })();
  if (!run) return terminal("failed");
  if (isTerminalStatus(run.status)) return terminal(run.status);
  if (run.status === "commit_failed") return terminal("failed");
  if (execution.isLive(runId) || execution.isInflight(runId)) {
    return execution.subscribe(runId, signal);
  }
  return (async function* () {
    await execution.abortStaleRun(runId);
    yield { type: "status", status: "aborted" };
  })();
}

export function createAgentRunExecutionService(
  deps: AgentRunExecutionDeps,
): AgentRunExecutionService {
  const { runPort, contextPort, backends, resolveWorkspace } = deps;
  const runTimeoutMs = deps.runTimeoutMs ?? 30 * 60_000;

  /** Process-lifetime live refs, only for steer/stop/current-event
   *  subscription. Removed when the run reaches a terminal state. */
  const liveRuns = new Map<string, LiveRun>();
  const inflight = new Set<string>();
  /** Worktree roots with a live dispatch (ADR 0023 §5): same-root runs
   *  queue instead of racing the same checkout. Keyed by workspace root. */
  const rootLocks = new Map<string, Promise<void>>();
  /** Dispatch promises by runId: dispose() drains them AFTER the children
   *  are dead so the DB is never closed mid-finalize. */
  const inflightPromises = new Map<string, Promise<void>>();
  let disposed = false;
  const subscribers = new Map<string, Set<(e: BackendEvent) => void>>();

  function broadcast(runId: string, event: BackendEvent): void {
    const set = subscribers.get(runId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        /* subscriber failure never affects the run */
      }
    }
  }

  function closeSubscribers(runId: string): void {
    subscribers.delete(runId);
  }

  /** Transient live-update fan-out: events from the run's segment are
   *  broadcast to current-process subscribers. Never persisted; subscriber
   *  failure never affects the run; the stream ends when the run settles.
   *  the run's event buffer (outcome). Returns a promise that resolves when
   *  the segment stream has been fully drained (used by dispatch to close
   *  subscribers only AFTER the last event broadcast). */
  function forwardEvents(runId: string, segment: BackendRunSegment): Promise<void> {
    return (async () => {
      try {
        for await (const ev of segment.events) broadcast(runId, ev);
      } catch {
        /* event stream closing is not a run failure */
      }
    })();
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Registry lookup with an explicit unknown-kind error. `modelRef.backendKind`
   *  is a plain string at runtime; kinds are compile-time labels, so the only
   *  honest check is against BACKEND_KINDS. */
  function entryFor(kind: string) {
    if (BACKEND_KINDS.includes(kind as BackendKind)) {
      return deps.backends[kind as BackendKind];
    }
    return undefined;
  }

  async function assertModelAvailable(modelRef: BackendModelRef): Promise<void> {
    const entry = entryFor(modelRef.backendKind);
    if (!entry) {
      throw new Error(
        `unknown or unregistered backend kind "${modelRef.backendKind}" ` +
          `(known: ${BACKEND_KINDS.join(", ")})`,
      );
    }
    const catalog = await entry.catalog.list();
    // Legacy model ids in DB rows resolve through the alias table
    // (e.g. claude-sonnet-4-20250514 → claude-sonnet-5).
    const model = catalog.models.find((m) => m.id === resolveModelAlias(modelRef.modelId));
    if (!model || model.available === false) {
      throw new Error(
        `model ${modelRef.backendKind}/${modelRef.modelId} not available in ${modelRef.backendKind} catalog`,
      );
    }
  }

  /** Project the FULL Agent Context branch into the Run's input. Every Run
   *  rebuilds from the complete projection - no incremental resume. */
  async function projectHistory(branchId: string): Promise<readonly ProjectedHistoryItem[]> {
    return projectAgentContext(
      { port: contextPort, ledgerResolver: deps.ledgerResolver },
      { branchId },
    );
  }

  /** First-turn bridge (ADR 0020 decision 6): when the branch has no CLI
   *  session yet, the projected product history is flattened into the input
   *  message as text — the CLI session becomes the runtime truth from the
   *  second turn on. Flat text loses tool structure; accepted. */
  function renderHistoryBridge(history: readonly ProjectedHistoryItem[]): string {
    return history
      .map((h) => {
        const who = h.message.role === "user" ? "User" : "Assistant";
        return `${who}: ${h.message.text}`;
      })
      .join("\n\n");
  }

  /** Assemble the BackendRunInput for a run's single input. The run's
   *  systemPrompt + skillRoots are the frozen snapshot persisted at Run
   *  creation - never re-resolved at dispatch (recovery reuses them); they
   *  stay in the contract as the run-scoped override channel (ADR 0020).
   *  The Product Context (identity + current task list) rides the same
   *  prompt so CLI backends carry their run identity into product tools. */
  function renderTodoSection(todoSnapshot: string | null): string {
    if (!todoSnapshot) {
      return "## Current Tasks\nNone yet. Use the todo_write product tool to track your task list.";
    }
    try {
      const items = JSON.parse(todoSnapshot) as readonly {
        id: string;
        text: string;
        status: string;
      }[];
      const marks = { pending: "- [ ]", in_progress: "- [~]", done: "- [x]" };
      return `## Current Tasks\n${items
        .map((t) => {
          const mark = marks[t.status as keyof typeof marks] ?? "- [ ]";
          return `${mark} ${t.text} (id: ${t.id})`;
        })
        .join("\n")}`;
    } catch {
      return "## Current Tasks\nNone yet. Use the todo_write product tool to track your task list.";
    }
  }

  function buildRunInput(
    run: AgentRun,
    history: readonly ProjectedHistoryItem[],
    input: BranchInput,
    workspace: WorkspaceBinding,
    cliSessionRef: string | undefined,
    lastTodo: string | null,
    productToolsToken: string,
  ): BackendRunInput {
    const bridge = !cliSessionRef && history.length > 0 ? renderHistoryBridge(history) : "";
    const inputText = input.message.text ?? "";
    const runSnapshot: {
      runId: string;
      model: typeof run.modelRef;
      configRevision: number;
      systemPrompt?: string;
      skillRoots?: readonly string[];
      cliSessionRef?: string;
      permissionMode?: "ask" | "auto" | "deny";
      workflowBudgetTokens?: number;
    } = {
      runId: run.runId,
      model: run.modelRef,
      configRevision: run.configRevision,
    };

    // CLI backends mount product tools through .mcp.json without the child's
    // per-call wire identity: the identity + task list ride the system
    // prompt, and the model passes the identity as a tool argument.
    // SECURITY NOTE: the identity is anti-ACCIDENT, not anti-MALICE - a
    // hostile model can forge any tuple it reads from the prompt. Hard
    // binding needs a per-run token (scheduled, see security-debt-backlog).
    const productContext = [
      "## Product Context",
      "Product tools (history_recent, history_search, history_around,",
      "history_retain, todo_write) require your run identity. Always pass it",
      "as the `identity` argument:",
      `- runId: ${run.runId}`,
      `- conversationId: ${run.conversationId}`,
      `- agentMemberId: ${run.agentMemberId}`,
      `- branchId: ${run.branchId}`,
      "",
      renderTodoSection(lastTodo),
    ].join("\n");
    if (run.systemPrompt) {
      runSnapshot.systemPrompt = `${run.systemPrompt}\n\n${productContext}`;
    } else {
      runSnapshot.systemPrompt = productContext;
    }
    if (run.skillRoots && run.skillRoots.length > 0) runSnapshot.skillRoots = run.skillRoots;
    if (cliSessionRef) runSnapshot.cliSessionRef = cliSessionRef;
    if (run.permissionMode) {
      runSnapshot.permissionMode = run.permissionMode as "ask" | "auto" | "deny";
    }
    if (run.workflowBudgetTokens != null)
      runSnapshot.workflowBudgetTokens = run.workflowBudgetTokens;
    return {
      input: {
        inputId: input.inputId,
        message: bridge ? { ...input.message, text: `${bridge}\n\n${inputText}` } : input.message,
      },
      run: runSnapshot,
      workspace,
      productToolsToken,
      metadata: {
        conversationId: run.conversationId,
        agentMemberId: run.agentMemberId,
        branchId: run.branchId,
      },
    };
  }

  async function deliverInput(
    run: AgentRun,
    claimed: ClaimedBranchInput,
    stage: { name: string },
  ): Promise<{
    outcome: BackendRunOutcome | null;
    segment: BackendRunSegment | null;
    /** Resolves when the segment's event stream has been fully drained. */
    drain: Promise<void>;
  }> {
    const { input, runId } = claimed;
    const entry = entryFor(run.modelRef.backendKind);
    if (!entry) {
      throw new Error(
        `unknown or unregistered backend kind "${run.modelRef.backendKind}" ` +
          `(known: ${BACKEND_KINDS.join(", ")})`,
      );
    }
    // Runtime dispatch is kind-agnostic: K is a compile-time label and the
    // registry is Partial<Record<kind, entry>>, so narrow once here.
    const backend = entry.backend as AgentBackend;
    // Workspace is a Run execution fact when the caller pinned it (Loop's
    // cloned repo); otherwise fall back to the agent-record default.
    stage.name = "resolve_workspace";
    const workspace =
      run.workspace ??
      (await resolveWorkspace({
        conversationId: run.conversationId,
        agentMemberId: run.agentMemberId,
      }));
    debugLog(
      "agent-run",
      `workspace_resolved runId=${runId} root=${workspace.root} access=${workspace.access}`,
    );

    // Steer is a control injection into the LIVE run: no new outcome of its
    // own. dispatchInner cancels steer inputs that lost their live handle
    // before this point; reaching here without one is a protocol error.
    if (input.mode === "steer") {
      const live = liveRuns.get(runId);
      if (!live) throw new Error(`steer requires a live run: ${runId}`);
      await backend.steer(runId, { inputId: input.inputId, message: input.message });
      await runPort.markInputAccepted(input.inputId);
      return { outcome: null, segment: live.segment, drain: Promise.resolve() };
    }

    // The run's Product Tool manifest MUST be durable BEFORE the Backend is
    // called: the child can invoke a Product Tool the moment it accepts, and
    // MCP authorization validates against the stored manifest - a
    // fire-and-forget write would race that first call.
    stage.name = "set_product_tools";
    await runPort.setRunProductTools(runId, [...buildHistoryTools(deps.productToolsEntrypoint)]);

    stage.name = "context_projection";
    const history = await projectHistory(run.branchId);
    // The branch's CLI session reference (ADR 0020 decision 6): an opaque
    // pointer the coding agent resolves natively — the product only
    // forwards it, never manages the session itself.
    const branch = await contextPort.getBranch(run.branchId);
    debugLog("agent-run", `context_projected runId=${runId} entries=${history.length}`);

    stage.name = "backend_execute";
    debugLog("agent-run", `backend_execute runId=${runId}`);
    // Per-run product-tools bearer: minted here, revoked in dispatchFn's
    // finally (every terminal path). A mint throw is a dispatch failure.
    const productToolsToken = deps.productToolsTokenRegistry.mint({
      runId,
      agentId: run.agentMemberId,
      exp: Date.now() + 30 * 60_000,
    });
    // The branch's CLI session ref is kind-scoped (`<kind>:<ref>`, ADR 0020
    // decision 6): a ref written by another backend is junk to this CLI and
    // must never be forwarded (pi exits empty on a foreign --session id).
    const kindPrefix = `${run.modelRef.backendKind}:`;
    const rawRef = branch?.cliSessionRef;
    // The previous run's task list re-enters the prompt so every backend
    // continues it without a pull round-trip.
    const lastTodo = await runPort.getLatestRunTodo(run.branchId);
    const cliSessionRef = rawRef?.startsWith(kindPrefix)
      ? rawRef.slice(kindPrefix.length)
      : undefined;
    const segment = await backend.execute(
      buildRunInput(run, history, input, workspace, cliSessionRef, lastTodo, productToolsToken),
    );
    liveRuns.set(runId, { segment });
    debugLog("agent-run", `backend_accepted runId=${runId}`);

    await runPort.markInputAccepted(input.inputId);
    debugLog("agent-run", `input_delivered runId=${runId} inputId=${input.inputId}`);
    const drain = forwardEvents(runId, segment);
    // Wall-clock run cap: a looping CLI (no native max-turns) must not own
    // the branch forever. stop() settles the segment aborted.
    const watchdog = setTimeout(() => {
      void backend.stop(runId).catch(() => {});
    }, runTimeoutMs);
    try {
      return { outcome: await segment.outcome, segment, drain };
    } finally {
      clearTimeout(watchdog);
    }
  }

  /** Terminal handling for one outcome: completed -> atomic Product commit;
   *  failed/aborted/timeout -> terminal Run without an assistant message. */
  async function settleOutcome(run: AgentRun, outcome: BackendRunOutcome): Promise<void> {
    // CLI session reference (ADR 0020 decision 6): kind-scoped on the
    // branch so a backend switch never hands a foreign id to the next CLI.
    if (outcome.cliSessionRef) {
      const scoped = `${run.modelRef.backendKind}:${outcome.cliSessionRef}`;
      await deps.contextPort.updateBranchCliSessionRef(run.branchId, scoped).catch(() => {});
    }
    if (outcome.status === "completed") {
      try {
        await runPort.commitCompletedRun({
          runId: run.runId,
          outcome,
          messages: outcome.messages ?? [],
        });
        debugLog(
          "agent-run",
          `terminal_commit runId=${run.runId} messages=${outcome.messages?.length ?? 0}`,
        );
        deps.onRunCommitted?.(run.runId, finalAnswerMessage(outcome.messages));
      } catch (err) {
        // Backend finished but the Product transaction failed: keep the
        // branch occupied, store the outcome for retryTerminalCommit. The
        // run is now terminal (commit_failed) - dispatch completes; the
        // failure is recoverable only through the explicit retry path.
        await runPort.failCommit(run.runId, outcome).catch(() => {});
        console.error(`[agent-run] commit failed for ${run.runId}:`, err);
      }
      return;
    }
    // Live subscribers learn WHY the run died (the error text) before the
    // stream closes; failed runs persist no assistant message, so this
    // status event is the only live failure record for the UI.
    broadcast(run.runId, { type: "status", status: outcome.status, error: outcome.error });
    await runPort.finalizeRun(run.runId, outcome);
  }

  /** One Run / one input: claim THIS run's bound input (acquire-time marker
   *  or crash recovery) and deliver it exactly once. The child rejects a
   *  second segment for an already-settled runId, so a run NEVER carries
   *  more than one real input; follow-ups chain into FRESH runs below. A
   *  steer input whose live run is gone is cancelled (never replayed as a
   *  cold start). */
  async function dispatchInner(runId: string): Promise<void> {
    // Failure diagnostics: which phase threw, so a stuck/dead run is
    // attributable without message/tool content (CODING_AGENT_DEBUG=1).
    const stage = { name: "load_run" };
    try {
      const run = await runPort.getRun(runId);
      if (!run || !isActiveStatus(run.status)) return;
      stage.name = "model_preflight";
      await assertModelAvailable(run.modelRef);
      debugLog("agent-run", `model_preflight_ok runId=${runId} model=${run.modelRef.modelId}`);

      for (let i = 0; i < 8; i++) {
        stage.name = "claim_input";
        const claimed = await runPort.claimInputForRun(runId);
        if (!claimed) break;
        if (claimed.input.mode === "steer" && !liveRuns.has(runId)) {
          // Crash residue: the steer was being injected when the process
          // died. Its live run is gone - cancel it explicitly instead of
          // silently replaying or converting it.
          await runPort.cancelInput(claimed.input.inputId);
          continue;
        }
        debugLog(
          "agent-run",
          `input_claimed runId=${runId} inputId=${claimed.input.inputId} mode=${claimed.input.mode}`,
        );
        // Same-worktree runs serialize (ADR 0023 §5): a shared checkout
        // must never host two concurrent children.
        const workspace0 =
          run.workspace ??
          (await resolveWorkspace({
            conversationId: run.conversationId,
            agentMemberId: run.agentMemberId,
          }));
        const prevLock = rootLocks.get(workspace0.root) ?? Promise.resolve();
        const { promise: turn, resolve: releaseTurn } = Promise.withResolvers<void>();
        rootLocks.set(
          workspace0.root,
          prevLock.then(() => turn),
        );
        await prevLock.catch(() => {});
        let deliverResult: Awaited<ReturnType<typeof deliverInput>>;
        try {
          deliverResult = await deliverInput(run, claimed, stage);
        } finally {
          releaseTurn();
          if (rootLocks.get(workspace0.root) === turn) rootLocks.delete(workspace0.root);
        }
        const { outcome, segment, drain } = deliverResult;
        if (outcome) {
          stage.name = "settle_outcome";
          debugLog("agent-run", `outcome runId=${runId} status=${outcome.status}`);
          await settleOutcome(run, outcome);
        }
        // Drain the transient event stream (bounded) so subscribers observe
        // the final events before the run's subscriber set closes.
        if (segment) await Promise.race([drain, sleep(500)]);
        break;
      }
      // liveRuns.delete + closeSubscribers happen in dispatchFn's finally so
      // EVERY exit path (normal outcome, preflight failure, child crash)
      // terminates the run's SSE subscriber stream.

      // Follow-up semantics: the oldest queued non-steer input becomes a
      // FRESH Run now that this one settled (one Run / one input / one loop,
      // never a second segment). The new Run is built from the queued input's
      // OWN config snapshot - never from this settled run's config.
      stage.name = "acquire_next";
      const next = await runPort.acquireNextRun(run.branchId);
      if (next) {
        void dispatchFn(next.runId).catch((err) => {
          console.error(`[agent-run] chain dispatch failed for ${next.runId}:`, err);
        });
      }
    } catch (error) {
      console.error(`[agent-run] dispatch_failed runId=${runId} stage=${stage.name}`, error);
      throw error;
    }
  }

  const dispatchFn = async (runId: string): Promise<void> => {
    if (disposed || inflight.has(runId)) return;
    inflight.add(runId);
    debugLog("agent-run", `dispatch_start runId=${runId}`);
    const promise = (async () => {
      try {
        await dispatchInner(runId);
      } catch (error) {
        // Any failure BEFORE the child accepted (model catalog, Context
        // projection, workspace resolution, child spawn, execute acceptance)
        // leaves the Run active with NO live child - a zombie. Terminal it:
        // Run failed, bound input cancelled, branch released, subscribers
        // closed. A running Run is never a retry queue; if automatic retry is
        // ever wanted it must be a NEW Run or an explicit retry state.
        const run = await runPort.getRun(runId);
        if (run && isActiveStatus(run.status) && !liveRuns.has(runId)) {
          const detail = error instanceof Error ? error.message : String(error);
          // Same live-failure record as settleOutcome's terminal branch:
          // pre-child failures (spawn, catalog, projection) leave no
          // assistant message, so the status event carries the error text.
          broadcast(runId, { type: "status", status: "failed", error: detail });
          await runPort
            .finalizeRun(runId, { status: "failed", error: detail })
            .catch((e) => console.error(`[agent-run] finalize failed for ${runId}:`, e));
          await runPort.cancelRunInput(runId).catch(() => {});
        }
        throw error;
      } finally {
        inflight.delete(runId);
        inflightPromises.delete(runId);
        liveRuns.delete(runId);
        // Every terminal path (outcome, preflight failure, crash) funnels
        // here: the run's product-tools bearer dies with the run.
        deps.productToolsTokenRegistry.revoke(runId);
        closeSubscribers(runId);
        debugLog("agent-run", `dispatch_end runId=${runId}`);
      }
    })();
    inflightPromises.set(runId, promise);
    await promise;
  };

  return {
    async dispatch(runId) {
      await dispatchFn(runId);
    },

    /** Inject a steer into the LIVE run of a branch. When the run has no
     *  live handle (settled, or on another process after restart) the input
     *  is cancelled and the caller gets an explicit error - a steer is never
     *  replayed as a normal input. */
    async injectSteer(
      branchId: string,
      input: { inputId: string; message: Message },
    ): Promise<void> {
      const active = await runPort.getActiveRun(branchId);
      if (!active) {
        // No active run: the steer cannot be delivered. Explicit conflict -
        // never silently dropped, never converted to a normal input.
        await runPort.cancelInput(input.inputId).catch(() => {});
        throw new Error(`steer rejected: no active run on branch ${branchId}`);
      }
      const live = liveRuns.get(active.runId);
      if (!live) {
        // The run is active in the DB but this process lost its live handle
        // (restart). Live steer cannot cross processes - cancel and report.
        await runPort.cancelInput(input.inputId).catch(() => {});
        throw new Error(`steer rejected: run ${active.runId} has no live loop on this process`);
      }
      const claimed = await runPort.deliverSteerInput(input.inputId, active.runId);
      if (!claimed) return; // already delivering/delivered or gone
      const entry = entryFor(active.modelRef.backendKind);
      if (!entry) {
        await runPort.cancelInput(input.inputId).catch(() => {});
        throw new Error(
          `steer rejected: unknown or unregistered backend kind "${active.modelRef.backendKind}" ` +
            `(known: ${BACKEND_KINDS.join(", ")})`,
        );
      }
      try {
        await (entry.backend as AgentBackend).steer(active.runId, {
          inputId: input.inputId,
          message: input.message,
        });
      } catch (err) {
        // The child rejected the steer (run settled in between): the input
        // must not linger as a phantom delivering row.
        await runPort.cancelInput(input.inputId).catch(() => {});
        throw err;
      }
      await runPort.markInputAccepted(input.inputId);
    },

    /** Startup recovery: redeliver every durable `delivering` input (same
     *  runId/inputId/idempotency - the Backend dedupes), promote every
     *  branch with a pending non-steer input that never became a Run
     *  (crash gap), and surface commit_failed runs for retryTerminalCommit.
     *  Called once at boot. */
    async recover() {
      const delivering = await runPort.listDeliveringInputs();
      for (const claimed of delivering) {
        await dispatchFn(claimed.runId).catch((err) => {
          console.error(`[agent-run] recover dispatch failed for ${claimed.runId}:`, err);
        });
      }
      // Crash gap: pending input with run_id IS NULL on an idle branch. Each
      // branch promotes its oldest input into a fresh Run from the input's
      // OWN snapshot (FIFO); acquireNextRun no-ops on busy branches.
      const idleBranches = await runPort.listIdleBranchesWithPendingInputs();
      for (const branchId of idleBranches) {
        const promoted = await runPort.acquireNextRun(branchId);
        if (!promoted) continue;
        await dispatchFn(promoted.runId).catch((err) => {
          console.error(`[agent-run] recover promote dispatch failed for ${promoted.runId}:`, err);
        });
      }
      const failed = await runPort.listCommitFailedRuns();
      for (const run of failed) {
        await this.retryTerminalCommit(run.runId).catch((err) => {
          console.error(`[agent-run] recover commit retry failed for ${run.runId}:`, err);
        });
      }
      // Restart orphans: a run whose input was DELIVERED (child accepted)
      // has no live child after a restart and cannot be resumed (one-shot
      // child architecture). Terminal it, cancel nothing (already
      // delivered), release the branch, and promote the next queued input.
      const orphans = await runPort.listActiveRunsWithDeliveredInputs();
      for (const orphan of orphans) {
        if (liveRuns.has(orphan.runId)) continue;
        debugLog(
          "agent-run",
          `recover_orphan runId=${orphan.runId} status=${orphan.status} branchId=${orphan.branchId}`,
        );
        await runPort
          .finalizeRun(orphan.runId, {
            status: "aborted",
            error: "stale run without live child after restart",
          })
          .catch((err) => {
            console.error(`[agent-run] recover orphan finalize failed for ${orphan.runId}:`, err);
          });
        const promoted = await runPort.acquireNextRun(orphan.branchId);
        if (!promoted) continue;
        await dispatchFn(promoted.runId).catch((err) => {
          console.error(`[agent-run] recover orphan promote failed for ${promoted.runId}:`, err);
        });
      }
    },

    /** Retry the Product commit of a commit_failed run from the STORED
     *  outcome only - never re-invokes the Backend. */
    async retryTerminalCommit(runId) {
      const run = await runPort.getRun(runId);
      if (run?.status !== "commit_failed" || !run.terminalResult) return;
      const outcome = run.terminalResult;
      if (outcome.status !== "completed") {
        // Non-completed terminal: finalize (idempotent) and release.
        await runPort.finalizeRun(runId, outcome).catch(() => {});
        return;
      }
      await runPort.commitCompletedRun({
        runId,
        outcome,
        messages: outcome.messages ?? [],
      });
      deps.onRunCommitted?.(runId, finalAnswerMessage(outcome.messages));
      liveRuns.delete(runId);
      closeSubscribers(runId);
    },

    async stop(runId) {
      const live = liveRuns.get(runId);
      if (live) {
        await live.segment.stop();
        return;
      }
      const run = await runPort.getRun(runId);
      if (run && isActiveStatus(run.status)) {
        // Zombie: active in DB, no live child. Terminal it, cancel its
        // input, and promote the next queued input so the branch does not
        // stay blocked by a run nobody can drive.
        await runPort.finalizeRun(runId, {
          status: "aborted",
          error: "stale run without live child",
        });
        await runPort.cancelRunInput(runId);
        const next = await runPort.acquireNextRun(run.branchId);
        if (next) {
          void dispatchFn(next.runId).catch((err) => {
            console.error(`[agent-run] chain dispatch failed for ${next.runId}:`, err);
          });
        }
      }
    },

    isLive(runId) {
      return liveRuns.has(runId);
    },

    isInflight(runId) {
      return inflight.has(runId);
    },

    async dispose() {
      disposed = true;
      // Children first: their exit settles every pending outcome/acceptance,
      // which unblocks the in-flight dispatches below.
      await Promise.all(Object.values(backends).map((entry) => entry.backend.dispose()));
      await Promise.allSettled([...inflightPromises.values()]);
      inflightPromises.clear();
    },

    async abortStaleRun(runId) {
      const run = await runPort.getRun(runId);
      if (!run || !isActiveStatus(run.status)) return;
      await runPort.finalizeRun(runId, {
        status: "aborted",
        error: "stale run without live child",
      });
      await runPort.cancelRunInput(runId);
    },

    subscribe(runId, signal) {
      return (async function* () {
        const pending: BackendEvent[] = [];
        const fn = (e: BackendEvent): void => {
          pending.push(e);
        };
        let set = subscribers.get(runId);
        if (!set) {
          set = new Set();
          subscribers.set(runId, set);
        }
        set.add(fn);
        try {
          // Drain `pending` even after closeSubscribers: a yield suspends
          // this generator, so the subscriber set can close while buffered
          // events are still unyielded. All broadcasts happen before the
          // close (the dispatch drain race orders them), so pending is
          // complete by then - never drop the tail.
          while (pending.length > 0 || subscribers.has(runId)) {
            if (signal?.aborted) break;
            if (pending.length > 0) {
              yield pending.shift()!;
              continue;
            }
            await new Promise((r) => setTimeout(r, 20));
          }
        } finally {
          set.delete(fn);
          if (set.size === 0) subscribers.delete(runId);
        }
      })();
    },
  };
}
