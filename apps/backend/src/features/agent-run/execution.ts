import type {
  CodingAgentBackend,
  CodingAgentModelCatalog,
} from "@my-agent-team/adapter-coding-agent";
import type {
  BackendEvent,
  BackendModelRef,
  BackendRunOutcome,
  BackendRunSegment,
  ProductToolDescriptor,
  ProjectedHistoryItem,
  WorkspaceBinding,
} from "@my-agent-team/agent-backend";
import type { Message } from "@my-agent-team/message";
import type {
  AgentContextPort,
  IdGenerator,
  LedgerMessageResolver,
} from "../agent-context/ports.js";
import { projectAgentContext } from "../agent-context/projection.js";
import type { AgentRun, BranchInput, ClaimedBranchInput } from "./domain.js";
import { isActiveStatus } from "./domain.js";
import type { AgentRunPort } from "./ports.js";

// ─── Product History Tools (the only canonical tool set) ─────────────

/** The Product Tool manifest: history read tools plus one semantic mutation
 *  (history_retain) with durable call idempotency. Entrypoint is the
 *  daemon-reachable Product Tools MCP endpoint (`sse:<url>`); it is injected
 *  per service so tests and deployments can point at a real endpoint. */
export function buildHistoryTools(entrypoint: string): readonly ProductToolDescriptor[] {
  return [
    {
      name: "history_recent",
      description:
        "Read the most recent messages visible to this agent member in the conversation. Returns the last N messages with their ledger seq and role.",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
      entrypoint,
    },
    {
      name: "history_search",
      description:
        "Search the conversation ledger for messages matching a keyword. Scoped to this run's conversation only.",
      inputSchema: {
        type: "object",
        properties: { keyword: { type: "string" }, limit: { type: "number" } },
        required: ["keyword"],
      },
      entrypoint,
    },
    {
      name: "history_around",
      description:
        "Read messages around a ledger seq in this conversation (context window before and after).",
      inputSchema: {
        type: "object",
        properties: {
          seq: { type: "number" },
          before: { type: "number" },
          after: { type: "number" },
        },
        required: ["seq"],
      },
      entrypoint,
    },
    {
      name: "history_retain",
      description:
        "Pin a conversation message into this agent's context branch so later runs keep it. Semantic mutation; replay-safe.",
      inputSchema: {
        type: "object",
        properties: { seq: { type: "number" }, reason: { type: "string" } },
        required: ["seq"],
      },
      entrypoint,
    },
  ];
}

// ─── Execution service ───────────────────────────────────────────────

export interface AgentRunExecutionDeps {
  readonly runPort: AgentRunPort;
  readonly contextPort: AgentContextPort;
  readonly ledgerResolver: LedgerMessageResolver;
  /** The one Backend. No registry: only backendKind=coding_agent. */
  readonly backend: CodingAgentBackend;
  readonly modelCatalog: CodingAgentModelCatalog;
  readonly idGen: IdGenerator;
  /** Resolve the workspace binding for a run's agent member (from the
   *  Agent's workspace path + permission mode; injected so tests and callers
   *  can vary it). Used ONLY when the Run itself did not pin a workspace
   *  snapshot. */
  readonly resolveWorkspace: (input: {
    conversationId: string;
    agentMemberId: string;
  }) => Promise<WorkspaceBinding>;
  /** Product Tools MCP endpoint the Coding Agent child connects to
   *  (`sse:<url>`), from PRODUCT_TOOLS_MCP_URL. */
  readonly productToolsEntrypoint: string;
  /** Called after a completed run's Product commit (History Message +
   *  Context ref) lands atomically. Fired on the original commit AND on
   *  retryTerminalCommit replay - consumers must be idempotent per
   *  (runId, ...). Used by Conversation for the mention cascade. */
  readonly onRunCommitted?: (runId: string, output: Message | undefined) => void;
}

interface LiveRun {
  readonly segment: BackendRunSegment<"coding_agent">;
}

export interface AgentRunExecutionService {
  dispatch(runId: string): Promise<void>;
  /** Steer injection into the live run of a branch. Explicit failure (input
   *  cancelled) when no live run exists - never a silent conversion. */
  injectSteer(branchId: string, input: { inputId: string; message: Message }): Promise<void>;
  recover(): Promise<void>;
  retryTerminalCommit(runId: string): Promise<void>;
  stop(runId: string): Promise<void>;
  subscribe(runId: string, signal?: AbortSignal): AsyncIterable<BackendEvent>;
}

export function createAgentRunExecutionService(
  deps: AgentRunExecutionDeps,
): AgentRunExecutionService {
  const { runPort, contextPort, backend, modelCatalog, resolveWorkspace } = deps;

  /** Process-lifetime live refs, only for steer/stop/current-event
   *  subscription. Removed when the run reaches a terminal state. */
  const liveRuns = new Map<string, LiveRun>();
  const inflight = new Set<string>();
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
   *  failure never affects the run; the stream ends when the daemon closes
   *  the run's event buffer (outcome). Returns a promise that resolves when
   *  the segment stream has been fully drained (used by dispatch to close
   *  subscribers only AFTER the last event broadcast). */
  function forwardEvents(runId: string, segment: BackendRunSegment<"coding_agent">): Promise<void> {
    return (async () => {
      try {
        for await (const ev of segment.events) broadcast(runId, ev);
      } catch {
        /* event stream closing is not a run failure */
      }
    })();
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  async function assertModelAvailable(modelRef: AgentRun["modelRef"]): Promise<void> {
    const catalog = await modelCatalog.list();
    const model = catalog.models.find((m) => m.id === modelRef.modelId);
    if (!model || model.available === false) {
      throw new Error(
        `model ${modelRef.backendKind}/${modelRef.modelId} not available in Coding Agent catalog`,
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

  /** Assemble the BackendRunInput for a run's single input. The run's
   *  systemPrompt + skillRoots are the frozen snapshot persisted at Run
   *  creation - never re-resolved at dispatch (recovery reuses them). */
  function buildRunInput(
    run: AgentRun,
    history: readonly ProjectedHistoryItem[],
    input: BranchInput,
    workspace: WorkspaceBinding,
  ): Parameters<CodingAgentBackend["execute"]>[0] {
    return {
      history,
      input: { inputId: input.inputId, message: input.message },
      run: {
        runId: run.runId,
        model: run.modelRef as BackendModelRef<"coding_agent">,
        ...(run.systemPrompt ? { systemPrompt: run.systemPrompt } : {}),
        ...(run.skillRoots && run.skillRoots.length > 0 ? { skillRoots: run.skillRoots } : {}),
        productTools: buildHistoryTools(deps.productToolsEntrypoint),
        configRevision: run.configRevision,
      },
      workspace,
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
  ): Promise<{
    outcome: BackendRunOutcome | null;
    segment: BackendRunSegment<"coding_agent"> | null;
    /** Resolves when the segment's event stream has been fully drained. */
    drain: Promise<void>;
  }> {
    const { input, runId } = claimed;
    // Workspace is a Run execution fact when the caller pinned it (Loop's
    // cloned repo); otherwise fall back to the agent-record default.
    const workspace =
      run.workspace ??
      (await resolveWorkspace({
        conversationId: run.conversationId,
        agentMemberId: run.agentMemberId,
      }));

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
    await runPort.setRunProductTools(runId, [...buildHistoryTools(deps.productToolsEntrypoint)]);

    const history = await projectHistory(run.branchId);
    const segment = await backend.execute(buildRunInput(run, history, input, workspace));
    liveRuns.set(runId, { segment });

    await runPort.markInputAccepted(input.inputId);
    const drain = forwardEvents(runId, segment);
    return { outcome: await segment.outcome, segment, drain };
  }

  /** Terminal handling for one outcome: completed -> atomic Product commit;
   *  failed/aborted/timeout -> terminal Run without an assistant message. */
  async function settleOutcome(run: AgentRun, outcome: BackendRunOutcome): Promise<void> {
    if (outcome.status === "completed") {
      try {
        await runPort.commitCompletedRun({
          runId: run.runId,
          outcome,
          output: outcome.output,
        });
        deps.onRunCommitted?.(run.runId, outcome.output);
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
    await runPort.finalizeRun(run.runId, outcome);
  }

  /** One Run / one input: claim THIS run's bound input (acquire-time marker
   *  or crash recovery) and deliver it exactly once. The daemon rejects a
   *  second segment for an already-settled runId, so a run NEVER carries
   *  more than one real input; follow-ups chain into FRESH runs below. A
   *  steer input whose live run is gone is cancelled (never replayed as a
   *  cold start). */
  async function dispatchInner(runId: string): Promise<void> {
    const run = await runPort.getRun(runId);
    if (!run || !isActiveStatus(run.status)) return;
    await assertModelAvailable(run.modelRef);

    for (let i = 0; i < 8; i++) {
      const claimed = await runPort.claimInputForRun(runId);
      if (!claimed) break;
      if (claimed.input.mode === "steer" && !liveRuns.has(runId)) {
        // Crash residue: the steer was being injected when the process
        // died. Its live run is gone - cancel it explicitly instead of
        // silently replaying or converting it.
        await runPort.cancelInput(claimed.input.inputId);
        continue;
      }
      const { outcome, segment, drain } = await deliverInput(run, claimed);
      if (outcome) {
        await settleOutcome(run, outcome);
      }
      // Drain the transient event stream (bounded) so subscribers observe
      // the final events before the run's subscriber set closes.
      if (segment) await Promise.race([drain, sleep(500)]);
      break;
    }
    liveRuns.delete(runId);
    closeSubscribers(runId);

    // Follow-up semantics: the oldest queued non-steer input becomes a
    // FRESH Run now that this one settled (one Run / one input / one loop,
    // never a second segment). The new Run is built from the queued input's
    // OWN config snapshot - never from this settled run's config.
    const next = await runPort.acquireNextRun(run.branchId);
    if (next) {
      void dispatchFn(next.runId).catch((err) => {
        console.error(`[agent-run] chain dispatch failed for ${next.runId}:`, err);
      });
    }
  }

  const dispatchFn = async (runId: string): Promise<void> => {
    if (inflight.has(runId)) return;
    inflight.add(runId);
    try {
      await dispatchInner(runId);
    } finally {
      inflight.delete(runId);
    }
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
      try {
        await backend.steer(active.runId, { inputId: input.inputId, message: input.message });
      } catch (err) {
        // The daemon rejected the steer (run settled in between): the input
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
        output: outcome.output,
      });
      deps.onRunCommitted?.(runId, outcome.output);
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
        await runPort.finalizeRun(runId, {
          status: "aborted",
          error: "stopped before backend acceptance",
        });
      }
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
