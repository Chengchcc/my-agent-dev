import type {
  AgentBackend,
  BackendModelRef,
  BackendRunOutcome,
  BackendRunSegment,
  ProjectedHistoryItem,
} from "@chengchenccc/agent-contract";
import { BACKEND_KINDS, type BackendKind, debugLog } from "@chengchenccc/agent-contract";
import { resolveModelAlias } from "@chengchenccc/ai";
import { DomainError } from "../../infra/domain-errors.js";
import { projectAgentContext } from "../agent-context/projection.js";
import { buildHistoryTools } from "../product-tools/manifest.js";
import type { AgentRun, ClaimedBranchInput } from "./domain.js";
import { isActiveStatus } from "./domain.js";
import { buildRunInput, finalAnswerMessage } from "./execution-input.js";
import type { LiveEventBus } from "./execution-live.js";
import type { AgentRunExecutionDeps, LiveRun } from "./execution-types.js";

export interface ExecutionDispatchCtx {
  deps: AgentRunExecutionDeps;
  liveEvents: LiveEventBus;
  liveRuns: Map<string, LiveRun>;
  inflight: Set<string>;
  inflightPromises: Map<string, Promise<void>>;
  state: { disposed: boolean };
}

export function createExecutionDispatcher(ctx: ExecutionDispatchCtx): {
  dispatchFn(runId: string): Promise<void>;
  entryFor(
    kind: string,
  ): AgentRunExecutionDeps["backends"][keyof AgentRunExecutionDeps["backends"]] | undefined;
} {
  const { deps, liveEvents, liveRuns, inflight, inflightPromises, state } = ctx;
  const { runPort, contextPort, resolveWorkspace } = deps;
  const runTimeoutMs = deps.runTimeoutMs ?? 30 * 60_000;

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
      // T3-3: config problems are known business errors — the unified
      // onError surfaces the message instead of swallowing it as 500.
      throw new DomainError(
        `unknown or unregistered backend kind "${modelRef.backendKind}" ` +
          `(known: ${BACKEND_KINDS.join(", ")})`,
        422,
      );
    }
    const catalog = await entry.catalog.list();
    // Legacy model ids in DB rows resolve through the alias table
    // (e.g. claude-sonnet-4-20250514 → claude-sonnet-5).
    const model = catalog.models.find((m) => m.id === resolveModelAlias(modelRef.modelId));
    if (!model || model.available === false) {
      throw new DomainError(
        `model ${modelRef.backendKind}/${modelRef.modelId} not available in ${modelRef.backendKind} catalog`,
        422,
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
        agentId: run.agentId,
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
    // pointer the oma resolves natively — the product only
    // forwards it, never manages the session itself.
    const branch = await contextPort.getBranch(run.branchId);
    debugLog("agent-run", `context_projected runId=${runId} entries=${history.length}`);

    stage.name = "backend_execute";
    debugLog("agent-run", `backend_execute runId=${runId}`);
    // Per-run product-tools bearer: minted here, revoked in dispatchFn's
    // finally (every terminal path). A mint throw is a dispatch failure.
    const productToolsToken = deps.productToolsTokenRegistry.mint({
      runId,
      agentId: run.agentId,
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
    // H1: the bridge is the ONLY author of workspace config files. Rewrite
    // from the DB source of truth right before spawn so an agent-tampered
    // .mcp.json (forged product-tools server, run-token exfil) never
    // mounts. Fail-closed: a failed rewrite aborts the dispatch.
    if (deps.rewriteWorkspaceBridge) {
      await deps.rewriteWorkspaceBridge(run.agentId, workspace.root);
    }
    const segment = await backend.execute(
      buildRunInput(
        deps,
        run,
        history,
        input,
        workspace,
        cliSessionRef,
        lastTodo,
        productToolsToken,
      ),
    );
    liveRuns.set(runId, { segment });
    debugLog("agent-run", `backend_accepted runId=${runId}`);

    await runPort.markInputAccepted(input.inputId);
    debugLog("agent-run", `input_delivered runId=${runId} inputId=${input.inputId}`);
    const drain = liveEvents.forwardEvents(runId, segment);
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
        const { seqs } = await runPort.commitCompletedRun({
          runId: run.runId,
          outcome,
          messages: outcome.messages ?? [],
        });
        debugLog(
          "agent-run",
          `terminal_commit runId=${run.runId} messages=${outcome.messages?.length ?? 0}`,
        );
        deps.onRunCommitted?.(run.runId, finalAnswerMessage(outcome.messages), seqs);
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
    // stream closes; the onRunFailed hook persists an assistant error
    // message so the failure survives refresh (T3-2).
    liveEvents.broadcast(run.runId, {
      type: "status",
      status: outcome.status,
      error: outcome.error,
    });
    deps.onRunFailed?.({
      runId: run.runId,
      conversationId: run.conversationId,
      agentId: run.agentId,
      error: outcome.error ?? `Run ${outcome.status}`,
    });
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
    // attributable without message/tool content (OMA_DEBUG=1).
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
            agentId: run.agentId,
          }));
        const deliverResult = await deps.workspaceLocks.withLock(workspace0.root, () =>
          deliverInput(run, claimed, stage),
        );
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
    if (state.disposed || inflight.has(runId)) return;
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
          liveEvents.broadcast(runId, { type: "status", status: "failed", error: detail });
          deps.onRunFailed?.({
            runId,
            conversationId: run.conversationId,
            agentId: run.agentId,
            error: detail,
          });
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
        liveEvents.closeSubscribers(runId);
        debugLog("agent-run", `dispatch_end runId=${runId}`);
      }
    })();
    inflightPromises.set(runId, promise);
    await promise;
  };

  return { dispatchFn, entryFor };
}
