import type { BackendInputMessage, Usage } from "@chengchenccc/agent-contract";
import type { Message } from "@chengchenccc/message";
import type { AgentLoopListener, OmaLoopEvent } from "./agent-event.js";
import type { LoopCallContext, LoopRuntimeState, LoopToolMapRef } from "./agent-loop-run.js";
import { type LoopRunnerBag, type LoopRunnerMutable, runLoop } from "./agent-loop-runner.js";
import type { OmaSession, OmaSessionOptions } from "./agent-loop-types.js";
import { compactSession } from "./compaction.js";
import { TokenEstimateCache } from "./message-cache.js";
import { collectTools, validatePlugins } from "./plugin.js";
import type { PluginRuntime } from "./plugin-runtime.js";

export type {
  ContextBudget,
  ContextSummarizer,
  ModelTurn,
  OmaLoopResult,
  OmaSession,
  OmaSessionOptions,
  StreamRule,
  TurnBlock,
} from "./agent-loop-types.js";
export type { AgentLoopListener, OmaLoopEvent };

export function createOmaSession(opts: OmaSessionOptions): OmaSession {
  validatePlugins(opts.plugins);
  const listeners = new Set<AgentLoopListener>();
  // Resolve the plugin runtime: opts.pluginRuntime from run-runtime, or a
  // minimal stub for tests that only need emit (backward-compatible).
  let rt: PluginRuntime = opts.pluginRuntime ?? {
    streamModel: async function* () {},
    store: opts.store,
    sessionId: opts.sessionId,
    workspaceRoot: "",
    emit: (event) => {
      void emit(event);
    },
    signal: new AbortController().signal,
  };
  // Static plugin tools + per-run resolved tools (Product Tool manifest).
  const baseTools = collectTools(opts.plugins);
  const toolMap = new Map(baseTools.map((t) => [t.name, t]));
  const toolMapRef: LoopToolMapRef = { current: toolMap };
  let status: "idle" | "running" | "completed" | "failed" | "stopped" = "idle";
  let runUsage: Usage | undefined;
  let active = false;
  let controller: AbortController | null = null;
  const steerQueue: BackendInputMessage[] = [];
  let acceptingSteer = false;
  let debugModelId = "";
  let debugTurn = 0;
  let debugRunId = "";
  const streamRuleInjections = new Map<string, number>();
  const state: LoopRuntimeState = {
    get runUsage() {
      return runUsage;
    },
    set runUsage(v) {
      runUsage = v;
    },
    get debugTurn() {
      return debugTurn;
    },
    set debugTurn(v) {
      debugTurn = v;
    },
    get debugModelId() {
      return debugModelId;
    },
    set debugModelId(v) {
      debugModelId = v;
    },
    get debugRunId() {
      return debugRunId;
    },
    set debugRunId(v) {
      debugRunId = v;
    },
    get streamRuleInjections() {
      return streamRuleInjections;
    },
    set streamRuleInjections(_v) {
      // streamRuleInjections is a const Map; only mutated, never reassigned.
    },
  };
  const tokenEstimateCache = new TokenEstimateCache();

  const mutable: LoopRunnerMutable = {
    get status() {
      return status;
    },
    set status(v) {
      status = v;
    },
    get active() {
      return active;
    },
    set active(v) {
      active = v;
    },
    get controller() {
      return controller;
    },
    set controller(v) {
      controller = v;
    },
    get rt() {
      return rt;
    },
    set rt(v) {
      rt = v;
    },
    get steerQueue() {
      return steerQueue;
    },
    set steerQueue(_v) {
      // steerQueue is a const array; only mutated, never reassigned.
    },
    get acceptingSteer() {
      return acceptingSteer;
    },
    set acceptingSteer(v) {
      acceptingSteer = v;
    },
  };

  async function emit(event: OmaLoopEvent): Promise<void> {
    for (const l of listeners) {
      try {
        await l(event);
      } catch {
        /* listener error is logged but not fatal */
      }
    }
  }

  const callCtx = (): LoopCallContext => ({
    opts,
    emit,
    toolMapRef,
    controller,
    rt,
    state,
  });

  const SESSION_MESSAGE_SOURCES = new Set([
    "prompt",
    "steer",
    "follow_up",
    "assistant",
    "tool_result",
    "system_reminder",
  ]);

  function persist(entries: readonly Record<string, unknown>[]): Promise<unknown> {
    if (opts.onPersistMessages) {
      const conversational = entries
        .filter(
          (e): e is Record<string, unknown> & { source: string; message: Message } =>
            e.type === "message" &&
            typeof e.source === "string" &&
            SESSION_MESSAGE_SOURCES.has(e.source) &&
            typeof e.message === "object" &&
            e.message !== null,
        )
        .map((e) => e.message);
      if (conversational.length > 0) opts.onPersistMessages(conversational);
    }
    return opts.store.appendBatch(opts.sessionId, { entries });
  }

  const loopBag: LoopRunnerBag = {
    opts,
    emit,
    persist,
    state,
    toolMapRef,
    callCtx,
    tokenEstimateCache,
    baseTools,
    mutable,
  };

  return {
    sessionId: opts.sessionId,
    get status() {
      return mutable.status;
    },

    async startLoop(deps) {
      return runLoop(loopBag, deps, "normal");
    },

    async startFollowUp(deps) {
      return runLoop(loopBag, deps, "follow_up");
    },
    steer(input: BackendInputMessage) {
      if (mutable.status !== "running" || !mutable.acceptingSteer) {
        throw new Error("Steer is only accepted during a loop with remaining turn capacity");
      }
      mutable.steerQueue.push(input);
    },

    stop() {
      mutable.controller?.abort();
    },
    async compact() {
      await emit({ type: "compaction_start" });
      await compactSession(
        opts.store,
        opts.sessionId,
        opts.summarize,
        mutable.controller?.signal,
        opts.contextBudget,
      );
      await emit({ type: "compaction_end" });
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event) {
      void emit(event);
    },
  };
}
