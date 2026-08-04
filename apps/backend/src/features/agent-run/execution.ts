import type {
  CodingAgentBackend,
  CodingAgentModelCatalog,
} from "@my-agent-team/adapter-coding-agent";
import type {
  BackendEvent,
  BackendModelRef,
  BackendRunOutcome,
  BackendRunSegment,
  BackendSessionRef,
  BackendStartInput,
  ProductToolDescriptor,
  ProjectedHistoryItem,
  WorkspaceBinding,
} from "@my-agent-team/agent-backend";
import type {
  AgentContextPort,
  IdGenerator,
  LedgerMessageResolver,
} from "../agent-context/ports.js";
import { projectAgentContext } from "../agent-context/projection.js";
import type { AgentRun, BranchInput, ClaimedBranchInput } from "./domain.js";
import { isActiveStatus } from "./domain.js";
import type { AgentRunPort } from "./ports.js";

// ─── Product History Tools (the only Phase 4 canonical tool set) ─────

/** The Phase 4 Product Tool manifest: history read tools plus one semantic
 *  mutation (history_retain) with durable call idempotency. Entrypoint is the
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
  /** The one Phase 4 Backend. No registry: only backendKind=coding_agent. */
  readonly backend: CodingAgentBackend;
  readonly modelCatalog: CodingAgentModelCatalog;
  readonly idGen: IdGenerator;
  /** Workspace binding for a run's agent member (from the Agent's workspace
   *  path + permission mode; injected so tests and Phase 5 callers can vary
   *  it without a new permission model). */
  readonly resolveWorkspace: (input: {
    conversationId: string;
    agentMemberId: string;
  }) => Promise<WorkspaceBinding>;
  /** Build the system prompt for a run. Phase 4 ships no canonical prompt
   *  system: the default returns undefined (no system prompt) and the
   *  integration test injects a minimal one. */
  readonly resolveSystemPrompt?: (run: AgentRun) => Promise<string | undefined>;
  /** Product Tools MCP endpoint the Coding Agent Worker connects to
   *  (`sse:<url>`), from PRODUCT_TOOLS_MCP_URL. */
  readonly productToolsEntrypoint: string;
}

interface LiveRun {
  readonly session: BackendSessionRef<"coding_agent">;
  readonly segment: BackendRunSegment<"coding_agent">;
}

export interface AgentRunExecutionService {
  dispatch(runId: string): Promise<void>;
  recover(): Promise<void>;
  retryTerminalCommit(runId: string): Promise<void>;
  stop(runId: string): Promise<void>;
  subscribe(runId: string, signal?: AbortSignal): AsyncIterable<BackendEvent>;
}

/** Pure resume/rebuild decision. The Backend Session Binding is the only
 *  persisted session metadata; a binding is reusable when it is active, names
 *  a live backend session, matches the branch's backend kind, the run has not
 *  failed its Product commit, and the branch has not moved past what the
 *  binding synced. model/systemPrompt/productTools/configRevision NEVER force
 *  a rebuild: they travel with every start/send/resume input.
 *
 *  Revision-gap invariant (<= 1 means resume): acquire bumps the branch
 *  revision exactly once per new Run, and every commit bumps it exactly once
 *  per written entry. So between a commit (binding.syncedRevision = the post-
 *  commit revision) and the next dispatch, the branch has advanced by at most
 *  the acquiring bump (gap 1 = the current input, safe to resume). Any gap > 1
 *  means OTHER context mutations (private messages, tool exchanges, retains,
 *  forks) happened after the sync - the binding no longer describes the
 *  branch, so rebuild from a full projection. */
export function decideExecutionPath(
  binding: {
    backendSessionId: string | null;
    backendKind: string;
    syncedEntryId: string | null;
    syncedRevision: number | null;
    state: string;
  } | null,
  branch: { backendKind: string; revision: number },
  run: AgentRun,
): "resume" | "rebuild" {
  if (!binding) return "rebuild";
  if (binding.state !== "active" || binding.backendSessionId == null) return "rebuild";
  if (binding.backendKind !== branch.backendKind) return "rebuild";
  if (run.status === "commit_failed") return "rebuild";
  if (binding.syncedEntryId == null) return "rebuild";
  const revGap = branch.revision - (binding.syncedRevision ?? 0);
  if (revGap > 1) return "rebuild";
  return "resume";
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
   *  the run's event buffer (outcome). */
  function forwardEvents(runId: string, segment: BackendRunSegment<"coding_agent">): void {
    void (async () => {
      try {
        for await (const ev of segment.events) broadcast(runId, ev);
      } catch {
        /* event stream closing is not a run failure */
      }
    })();
  }

  async function assertModelAvailable(modelRef: AgentRun["modelRef"]): Promise<void> {
    const catalog = await modelCatalog.list();
    const model = catalog.models.find((m) => m.id === modelRef.modelId);
    if (!model || model.available === false) {
      throw new Error(
        `model ${modelRef.backendKind}/${modelRef.modelId} not available in Coding Agent catalog`,
      );
    }
  }

  /** Assemble the BackendStartInput for a run's first input (start/resume). */
  function buildStartInput(
    run: AgentRun,
    history: readonly ProjectedHistoryItem[],
    input: BranchInput,
    workspace: WorkspaceBinding,
    systemPrompt: string | undefined,
  ): BackendStartInput<"coding_agent"> {
    return {
      history,
      input: { inputId: input.inputId, message: input.message },
      run: {
        runId: run.runId,
        model: run.modelRef as BackendModelRef<"coding_agent">,
        ...(systemPrompt ? { systemPrompt } : {}),
        productTools: buildHistoryTools(deps.productToolsEntrypoint),
        configRevision: run.configRevision,
      },
      workspace,
      metadata: {
        conversationId: run.conversationId,
        agentMemberId: run.agentMemberId,
        branchId: run.branchId,
        productRevision: run.configRevision,
      },
    };
  }

  /** Project history for a start/resume (optionally through the binding's
   *  synced entry for an incremental resume). */
  async function projectHistory(
    branchId: string,
    throughEntryId?: string,
  ): Promise<readonly ProjectedHistoryItem[]> {
    return projectAgentContext(
      { port: contextPort, ledgerResolver: deps.ledgerResolver },
      { branchId, throughEntryId },
    );
  }

  async function deliverInput(
    run: AgentRun,
    claimed: ClaimedBranchInput,
  ): Promise<{
    outcome: BackendRunOutcome | null;
    segment: BackendRunSegment<"coding_agent"> | null;
    backendSessionId: string;
  }> {
    const { input, runId } = claimed;
    const live = liveRuns.get(runId);
    const workspace = await resolveWorkspace({
      conversationId: run.conversationId,
      agentMemberId: run.agentMemberId,
    });

    // Steer is a control injection into the LIVE run: no new outcome of its
    // own. It requires an in-memory live segment on this process.
    if (input.mode === "steer") {
      if (!live) throw new Error(`steer requires a live run: ${runId}`);
      await backend.send(live.session, {
        history: [],
        input: { inputId: input.inputId, message: input.message },
        run: {
          runId: run.runId,
          model: run.modelRef as BackendModelRef<"coding_agent">,
          productTools: buildHistoryTools(deps.productToolsEntrypoint),
          configRevision: run.configRevision,
        },
        mode: "steer",
        metadata: { branchId: run.branchId, productRevision: run.configRevision },
      });
      await runPort.markInputAccepted(input.inputId);
      return { outcome: null, segment: null, backendSessionId: live.session.backendSessionId };
    }

    const systemPrompt = deps.resolveSystemPrompt ? await deps.resolveSystemPrompt(run) : undefined;

    if (live) {
      // Same-process continuation: send on the live session (follow_up).
      const segment = await backend.send(live.session, {
        history: [],
        input: { inputId: input.inputId, message: input.message },
        run: {
          runId: run.runId,
          model: run.modelRef as BackendModelRef<"coding_agent">,
          ...(systemPrompt ? { systemPrompt } : {}),
          productTools: buildHistoryTools(deps.productToolsEntrypoint),
          configRevision: run.configRevision,
        },
        mode: input.mode === "follow_up" ? "follow_up" : "normal",
        metadata: {
          branchId: run.branchId,
          throughEntryId: undefined,
          productRevision: run.configRevision,
        },
      });
      await runPort.markInputAccepted(input.inputId);
      forwardEvents(runId, segment);
      return {
        outcome: await segment.outcome,
        segment,
        backendSessionId: live.session.backendSessionId,
      };
    }

    // Cold path: resume when the binding is reusable, otherwise rebuild from
    // the full projection. The run's Product Tool manifest MUST be durable
    // BEFORE the Backend is called: the Worker can invoke a Product Tool the
    // moment it accepts, and MCP authorization validates against the stored
    // manifest - a fire-and-forget write would race that first call.
    await runPort.setRunProductTools(runId, [...buildHistoryTools(deps.productToolsEntrypoint)]);
    const binding = await contextPort.getBinding(run.branchId);
    const branch = await contextPort.getBranch(run.branchId);
    if (!branch) throw new Error(`Branch not found: ${run.branchId}`);
    const path = decideExecutionPath(binding, branch, run);

    let session: BackendSessionRef<"coding_agent">;
    let segment: BackendRunSegment<"coding_agent">;
    if (path === "resume" && binding?.backendSessionId) {
      const history = await projectHistory(run.branchId, binding.syncedEntryId ?? undefined);
      const resumed = await backend.resume(binding.backendSessionId, {
        ...buildStartInput(run, history, input, workspace, systemPrompt),
        run: {
          runId: run.runId,
          model: run.modelRef as BackendModelRef<"coding_agent">,
          ...(systemPrompt ? { systemPrompt } : {}),
          productTools: buildHistoryTools(deps.productToolsEntrypoint),
          configRevision: run.configRevision,
        },
      });
      session = resumed.session;
      segment = resumed.segment;
    } else {
      if (binding) await contextPort.markBindingStale(run.branchId);
      const history = await projectHistory(run.branchId);
      const started = await backend.start(
        buildStartInput(run, history, input, workspace, systemPrompt),
      );
      session = started.session;
      segment = started.segment;
      liveRuns.set(runId, { session, segment });
    }

    await runPort.markInputAccepted(input.inputId);
    forwardEvents(runId, segment);
    return { outcome: await segment.outcome, segment, backendSessionId: session.backendSessionId };
  }

  /** Terminal handling for one outcome: completed -> atomic Product commit;
   *  failed/aborted/timeout -> terminal Run without an assistant message and
   *  a stale binding; suspended is unsupported (failed). */
  async function settleOutcome(
    run: AgentRun,
    outcome: BackendRunOutcome,
    isFinal: boolean,
    backendSessionId: string,
  ): Promise<void> {
    if (!isFinal) return; // intermediate send outcome: product facts untouched
    if (outcome.status === "completed") {
      try {
        await runPort.commitCompletedRun({
          runId: run.runId,
          outcome,
          output: outcome.output,
          backendSessionId,
        });
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
    if (outcome.status === "suspended") {
      await runPort.finalizeRun(run.runId, {
        status: "failed",
        error: "suspended outcomes are not supported by coding_agent",
      });
    } else {
      await runPort.finalizeRun(run.runId, outcome);
    }
    await contextPort.markBindingStale(run.branchId).catch(() => {});
  }

  async function dispatchInner(runId: string): Promise<void> {
    const run = await runPort.getRun(runId);
    if (!run || !isActiveStatus(run.status)) return;
    await assertModelAvailable(run.modelRef);

    const branch = await contextPort.getBranch(run.branchId);
    if (!branch) throw new Error(`Branch not found: ${run.branchId}`);
    void branch;

    // Deliver every queued input of this run in queue order: the first via
    // start/resume, follow-ups via send on the live segment, steer injected.
    let claimed = await runPort.claimNextInput(run.branchId);
    while (claimed && claimed.runId === runId) {
      const { outcome, backendSessionId } = await deliverInput(run, claimed);

      // The outcome the caller sees: for the LAST input only. Earlier
      // outcomes are intermediate (product facts untouched).
      const next = await runPort.claimNextInput(run.branchId);
      const isFinal = !next || next.runId !== runId;
      if (outcome) {
        await settleOutcome(run, outcome, isFinal, backendSessionId);
      }
      // Live ref lives until the run is terminal; steer/follow-ups keep it.
      if (isFinal) {
        liveRuns.delete(runId);
        closeSubscribers(runId);
        return;
      }
      claimed = next;
    }
    // No more inputs of this run: the run was already terminal or nothing
    // was claimed. Nothing to do.
  }

  return {
    async dispatch(runId) {
      if (inflight.has(runId)) return;
      inflight.add(runId);
      try {
        await dispatchInner(runId);
      } finally {
        inflight.delete(runId);
      }
    },

    /** Startup recovery: redeliver every durable `delivering` input (same
     *  runId/inputId/idempotency - the Backend dedupes) and surface
     *  commit_failed runs for retryTerminalCommit. Called once at boot. */
    async recover() {
      const delivering = await runPort.listDeliveringInputs();
      for (const claimed of delivering) {
        await this.dispatch(claimed.runId).catch((err) => {
          console.error(`[agent-run] recover dispatch failed for ${claimed.runId}:`, err);
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
        await contextPort.markBindingStale(run.branchId).catch(() => {});
        return;
      }
      const binding = await contextPort.getBinding(run.branchId);
      await runPort.commitCompletedRun({
        runId,
        outcome,
        output: outcome.output,
        backendSessionId: binding?.backendSessionId ?? "",
      });
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
        await contextPort.markBindingStale(run.branchId).catch(() => {});
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
          while (subscribers.has(runId)) {
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
