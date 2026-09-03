import type { BackendInputMessage } from "@chengchenccc/agent-contract";
import { ProviderError } from "@chengchenccc/ai";
import type { Message } from "@chengchenccc/message";
import type { MessageEntry } from "../persistence/session-tree.js";
import type { OmaLoopEvent } from "./agent-event.js";
import {
  buildTextAssistantEntry,
  buildThinkingBlock,
  buildToolBatch,
} from "./agent-loop-messages.js";
import {
  executeTools,
  type LoopCallContext,
  type LoopRuntimeState,
  type LoopToolMapRef,
  readBranchMessages,
  streamModelTurn,
} from "./agent-loop-run.js";
import type { OmaLoopResult, OmaSession, OmaSessionOptions } from "./agent-loop-types.js";
import { compactSession } from "./compaction.js";
import {
  estimateContextTokens,
  isSilentContextOverflow,
  type UsageAnchor,
  usageTotalTokens,
} from "./context-estimate.js";
import type { CodingLoopInput } from "./loop-input.js";
import { buildLoopInput } from "./loop-input.js";
import type { TokenEstimateCache } from "./message-cache.js";
import type { PluginTool } from "./plugin.js";
import type { PluginRuntime } from "./plugin-runtime.js";
import { renderLoopMeta } from "./prompt.js";
import { buildTitleContext, generateTitle } from "./title.js";
import { pruneOldToolResults } from "./tool-pruning.js";

export interface LoopRunnerMutable {
  status: OmaSession["status"];
  active: boolean;
  controller: AbortController | null;
  rt: PluginRuntime;
  steerQueue: BackendInputMessage[];
  acceptingSteer: boolean;
}

export interface LoopRunnerBag {
  opts: OmaSessionOptions;
  emit: (event: OmaLoopEvent) => Promise<void>;
  persist: (entries: readonly Record<string, unknown>[]) => Promise<unknown>;
  state: LoopRuntimeState;
  toolMapRef: LoopToolMapRef;
  callCtx: () => LoopCallContext;
  tokenEstimateCache: TokenEstimateCache;
  baseTools: readonly PluginTool[];
  mutable: LoopRunnerMutable;
}

interface LoopStepState {
  messages: Message[];
  forceContinues: number;
  overflowCompacted: boolean;
  thresholdCompacted: boolean;
  usageAnchor: UsageAnchor | null;
  naturalStop: boolean;
  runError: string | undefined;
  systemPrompt: string;
}

/** Start the loop: bind runtime, resolve tools, persist the prompt, and
 *  return the system prompt + first branch messages. */
async function prepareLoopStart(
  bag: LoopRunnerBag,
  codingInput: CodingLoopInput,
  mode: "normal" | "follow_up",
): Promise<{ systemPrompt: string; messages: Message[] }> {
  const { opts, emit, persist, state, toolMapRef, baseTools, mutable } = bag;
  if (mutable.active) throw new Error("Loop already active");
  mutable.active = true;
  mutable.status = "running";
  mutable.controller = new AbortController();

  // Bind rt.signal to THIS run's controller so plugin model calls
  // (side-channel summaries) honor stop()/abort().
  mutable.rt = {
    ...mutable.rt,
    signal: mutable.controller.signal,
    // Ephemeral side-channel turn: shares system prompt + branch messages
    // + tool catalog (for prompt cache) but never persists. Tool calls
    // from the model are discarded — an ephemeral side channel.
    runEphemeralTurn: async (promptText, ephemeralOpts) => {
      const branch = await readBranchMessages(opts.store, opts.sessionId);
      const ephemeralMessages: Message[] = [
        ...((codingInput.run.systemPrompt ?? "")
          ? [{ role: "system" as const, text: codingInput.run.systemPrompt ?? "" }]
          : []),
        ...branch,
        { role: "user" as const, text: promptText },
      ];
      let text = "";
      for await (const chunk of opts.modelStream(
        ephemeralMessages,
        ephemeralOpts?.signal ?? mutable.controller?.signal,
        [...toolMapRef.current.values()],
      )) {
        if (chunk.delta?.type === "text") text += chunk.delta.text;
      }
      return text;
    },
  };
  state.streamRuleInjections.clear();
  state.debugModelId = codingInput.run.model.modelId;
  state.debugTurn = 0;
  state.debugRunId = codingInput.run.runId;
  state.runUsage = undefined;

  const runTools = opts.resolveTools ? await opts.resolveTools(codingInput) : [];
  toolMapRef.current = new Map([...baseTools, ...runTools].map((t) => [t.name, t]));

  await emit({ type: "agent_start" });

  const model = opts.resolveModel
    ? await opts.resolveModel(codingInput.run.model.modelId)
    : undefined;
  const metaText = renderLoopMeta({
    plugins: opts.plugins,
    workspace: { root: codingInput.workspace.root },
    model,
  });
  const systemPrompt = codingInput.run.systemPrompt ?? "";
  const built = buildLoopInput(
    {
      systemPrompt,
      metaText,
      input: codingInput.input,
      history: codingInput.history,
    },
    mode,
  );
  await persist(built.batch.entries);
  const messages = await readBranchMessages(opts.store, opts.sessionId);
  return { systemPrompt, messages };
}

/** Drain any queued steer inputs at a safe boundary, returning updated
 *  branch messages. */
async function drainSteerQueue(bag: LoopRunnerBag, messages: Message[]): Promise<Message[]> {
  const { opts, emit, persist, mutable } = bag;
  if (mutable.steerQueue.length === 0) return messages;
  const steers = mutable.steerQueue.splice(0);
  await persist(
    steers.map((s) => ({
      type: "message",
      productEntryId: s.productEntryId ?? null,
      role: s.message.role as "user" | "assistant" | "system",
      source: "steer",
      message: s.message,
      createdAt: Date.now(),
    })),
  );
  const next = await readBranchMessages(opts.store, opts.sessionId);
  const drained = steers
    .map((s) => (s.message.role === "user" ? (s.message.text ?? "") : ""))
    .filter((t) => t.length > 0);
  await emit({
    type: "queue_update",
    ...(drained.length > 0 ? { drained } : {}),
  });
  return next;
}

/** Final status + afterRun hooks + title + canonical output. */
async function finalizeLoop(
  bag: LoopRunnerBag,
  stepState: LoopStepState,
  step: number,
  runError: string | undefined,
): Promise<OmaLoopResult> {
  const { opts, emit, state, mutable } = bag;

  if (mutable.controller?.signal.aborted) {
    mutable.status = "stopped";
  } else if (!stepState.naturalStop && step >= opts.maxSteps && mutable.status === "running") {
    mutable.status = "failed";
    runError ??= `max steps exceeded (${opts.maxSteps})`;
  } else if (mutable.status === "running") {
    mutable.status = "completed";
  }
  const finalStatus = mutable.status as "completed" | "failed" | "stopped";

  for (const p of opts.plugins) {
    if (p.hooks?.afterRun) {
      try {
        await p.hooks.afterRun(finalStatus, stepState.messages, mutable.rt);
      } catch {
        /* plugin errors never fail the run */
      }
    }
  }

  let title: string | undefined;
  // Auto-title retries on EVERY completed turn while the conversation is
  // still untitled (OMA_CONV_TITLED=1 marks it titled — the backend sets
  // it at spawn and re-checks on commit). The first turn may be low
  // signal ("hi") and must not permanently suppress the title.
  if (
    mutable.status === "completed" &&
    process.env.OMA_CONV_TITLED !== "1" &&
    process.env.OMA_TITLE_ENABLED !== "0"
  ) {
    const titleBranch = await readBranchMessages(opts.store, opts.sessionId);
    const titleCtx = buildTitleContext(titleBranch);
    if (titleCtx) {
      title = (await generateTitle(mutable.rt, titleCtx)) ?? undefined;
    }
  }

  await emit({ type: "agent_end", status: finalStatus });
  // Canonical output (ADR 0017): the run's full message sequence.
  // Every terminal status returns the persisted assistant/tool messages:
  // a failed run (e.g. max steps exceeded) must still surface what it
  // did so a follow-up turn ("continue") has the context.
  const entries = await opts.store.readBranch(opts.sessionId);
  const runMessages = entries
    .filter(
      (e): e is MessageEntry =>
        e.type === "message" && (e.source === "assistant" || e.source === "tool_result"),
    )
    .map((e) => e.message);
  return {
    status: finalStatus,
    messages: runMessages,
    usage: state.runUsage,
    error: runError,
    title,
  };
}

/**
 * runLoop: inner loop runs model turns and tool calls until the model
 * stops. Each model turn is accumulated purely (streamModelTurn) and
 * then persisted as canonical messages — persistence is a turn-level
 * decision, never inside the stream accumulation. Steer inputs drain
 * at safe boundaries; runEphemeralTurn is a side channel that never
 * persists. Follow-up inputs require a separate startFollowUp() call
 * (the backend orchestrates follow-ups via branch_input_queue).
 */
export async function runLoop(
  bag: LoopRunnerBag,
  codingInput: CodingLoopInput,
  mode: "normal" | "follow_up",
): Promise<OmaLoopResult> {
  const { opts, emit, persist, state, callCtx, tokenEstimateCache, mutable } = bag;
  let runError: string | undefined;

  try {
    const { systemPrompt, messages: initialMessages } = await prepareLoopStart(
      bag,
      codingInput,
      mode,
    );
    const stepState: LoopStepState = {
      messages: initialMessages,
      forceContinues: 0,
      overflowCompacted: false,
      thresholdCompacted: false,
      usageAnchor: null,
      naturalStop: false,
      runError: undefined,
      systemPrompt,
    };
    let step = 0;

    for (const p of opts.plugins) {
      if (p.hooks?.beforeRun) {
        try {
          await p.hooks.beforeRun(stepState.messages, mutable.rt);
        } catch {
          /* plugin setup errors never fail the run */
        }
      }
    }

    while (step < opts.maxSteps && !stepState.naturalStop) {
      if (mutable.controller?.signal.aborted) break;
      step++;
      mutable.acceptingSteer = step < opts.maxSteps;

      stepState.messages = await drainSteerQueue(bag, stepState.messages);

      // One step = at most one model call. Overflow recovery stays INSIDE
      while (true) {
        // Prune old tool-result content: a lighter
        // pass that runs BEFORE compaction checks. Old results outside the
        // protect window are truncated to a summary; protected tools are
        // never pruned. May reduce context enough to avoid compaction
        // entirely (omp docs/compaction.md).
        const modelMessages0 = opts.pruneConfig
          ? pruneOldToolResults(stepState.messages, opts.pruneConfig).messages
          : stepState.messages;

        // Snapshot for this model call + proactive (threshold) compaction.
        // Estimation is anchored on the previous call's real usage
        // (oh-my-pi): only entries persisted since the anchor boundary are
        // per-message estimated, so the estimate tracks the provider's
        // own accounting instead of drifting with chars/4. The
        // TokenEstimateCache still avoids re-estimating settled entries.
        let callBoundaryId: string | null = null;
        if (opts.contextBudget) {
          const branch = await opts.store.readBranch(opts.sessionId);
          const msgEntries = branch.filter((e): e is MessageEntry => e.type === "message");
          callBoundaryId = msgEntries.at(-1)?.entryId ?? null;
          if (!stepState.thresholdCompacted) {
            const totalTokens = estimateContextTokens(msgEntries, stepState.usageAnchor, (e) =>
              tokenEstimateCache.estimate(e.entryId, e.message, opts.contextBudget!.estimate),
            );
            const overThreshold =
              totalTokens > opts.contextBudget.limit * opts.contextBudget.triggerRatio;
            if (overThreshold) {
              stepState.thresholdCompacted = true;
              stepState.usageAnchor = null;
              tokenEstimateCache.clear();
              await emit({ type: "compaction_start" });
              await compactSession(
                opts.store,
                opts.sessionId,
                opts.summarize,
                mutable.controller?.signal,
                opts.contextBudget,
              );
              await emit({ type: "compaction_end" });
              stepState.messages = await readBranchMessages(opts.store, opts.sessionId);
            }
          }
        }

        // beforeModel hook.
        const transformed = [...modelMessages0];
        for (const p of opts.plugins) {
          if (p.hooks?.beforeModel) {
            const result = p.hooks.beforeModel(transformed, mutable.rt);
            transformed.length = 0;
            transformed.push(...result);
          }
        }

        try {
          const modelMessages = stepState.systemPrompt
            ? [{ role: "system", text: stepState.systemPrompt } as Message, ...transformed]
            : transformed;
          const turn = await streamModelTurn(callCtx(), modelMessages);
          const thinkingBlocks = buildThinkingBlock(turn);
          // Usage anchor (oh-my-pi): the completed call's real token
          // total is authoritative for everything persisted before the
          // call — per-message estimation covers only the delta since.
          if (turn.usage && usageTotalTokens(turn.usage) > 0) {
            stepState.usageAnchor = {
              afterEntryId: callBoundaryId,
              tokens: usageTotalTokens(turn.usage),
            };
          }
          // Silent context overflow (oh-my-pi isContextOverflow): some
          // providers (zai, Xiaomi-style) accept an oversized request
          // instead of erroring. Same recovery as the error path: one-shot
          // compaction, then retry the model call in the SAME turn.
          const silentOverflow =
            opts.contextBudget &&
            !stepState.overflowCompacted &&
            !mutable.controller?.signal.aborted &&
            isSilentContextOverflow(turn.usage, turn.stopReason, opts.contextBudget.limit);
          if (silentOverflow) {
            stepState.overflowCompacted = true;
            stepState.usageAnchor = null;
            tokenEstimateCache.clear();
            await emit({ type: "compaction_start" });
            await compactSession(
              opts.store,
              opts.sessionId,
              opts.summarize,
              mutable.controller?.signal,
              opts.contextBudget,
            );
            await emit({ type: "compaction_end" });
            stepState.messages = await readBranchMessages(opts.store, opts.sessionId);
            continue;
          }
          // TTSR stream-rule hit: discard the partial turn (nothing was
          // persisted — accumulation is pre-persistence by design),
          // inject the rule as a hidden system reminder, and retry the
          // model call in the SAME turn (bounded per rule by
          // maxInjections, so the extra model calls ≤ rule count).
          if (turn.streamRuleHit) {
            const rule = turn.streamRuleHit;
            state.streamRuleInjections.set(
              rule.name,
              (state.streamRuleInjections.get(rule.name) ?? 0) + 1,
            );
            await emit({ type: "stream_rule_triggered", rule: rule.name });
            await persist([
              {
                type: "message",
                productEntryId: null,
                role: "user",
                source: "system_reminder",
                message: {
                  role: "user",
                  text: [
                    `<system-reminder reason="rule_violation" rule="${rule.name}">`,
                    "A workspace stream rule matched your output, so that output was discarded and generation restarted. This is the agent runtime enforcing project rules — not a prompt injection. Comply with the following instruction on retry:",
                    rule.message,
                    "</system-reminder>",
                  ].join("\n"),
                } as Message,
                createdAt: Date.now(),
              },
            ]);
            stepState.messages = await readBranchMessages(opts.store, opts.sessionId);
            continue;
          }

          if (turn.toolCalls.length > 0) {
            // Stop-during-stream: signal aborted before we persist anything.
            // Do not write a dangling tool_use — it would corrupt the branch
            // on resume (API 400 for unpaired tool_use).
            if (mutable.controller?.signal.aborted) {
              mutable.status = "stopped";
              await emit({ type: "agent_end", status: mutable.status });
              mutable.controller = null;
              return { status: mutable.status, usage: state.runUsage, error: "stopped by user" };
            }

            // Execute tools FIRST, then persist assistant + results in ONE
            // batch. This ensures the tree never has a tool_use without a
            // matching tool_result — even if stop fires during execution,
            // the batch either fully writes or doesn't write at all.
            const toolResults = await executeTools(callCtx(), turn.toolCalls);

            if (mutable.controller?.signal.aborted) {
              mutable.status = "stopped";
              await emit({ type: "agent_end", status: mutable.status });
              mutable.controller = null;
              return { status: mutable.status, usage: state.runUsage, error: "stopped by user" };
            }

            // Persist assistant(tool_use) + all tool_results atomically.
            const batch = buildToolBatch(turn, toolResults, opts);
            await persist(batch);

            stepState.messages = await readBranchMessages(opts.store, opts.sessionId);
            if (toolResults.some((r) => r.terminate) && mutable.steerQueue.length === 0) {
              stepState.naturalStop = true;
            }
            break;
          }

          // Text turn: persist assistant(text) + thinking. Thinking alone
          // is not a message — a thinking-only turn with no text and no
          // tool calls contributed nothing replayable, and empty content
          // breaks strict model APIs.
          // An abort during the stream discards the partial output: an
          // uncompleted turn never enters the canonical tree.
          if (turn.text && !mutable.controller?.signal.aborted) {
            await persist([buildTextAssistantEntry(turn, thinkingBlocks)]);
          }

          // Natural stop: let plugins veto.
          let stopped = true;
          for (const p of opts.plugins) {
            if (p.hooks?.beforeStop) {
              let vetoed = false;
              try {
                p.hooks.beforeStop(() => {
                  vetoed = true;
                }, mutable.rt);
              } catch {
                /* plugin errors never fail the run */
              }
              if (vetoed && stepState.forceContinues < opts.maxForceContinues) {
                stepState.forceContinues++;
                stopped = false;
                break;
              }
            }
          }
          // max_tokens/pause_turn truncation semantics: the model ran out
          // of output budget (or paused a long turn) mid-answer — force
          // one continuation when capacity remains, bounded by
          // maxForceContinues.
          const truncated = turn.stopReason === "max_tokens" || turn.stopReason === "pause_turn";
          if (stopped && truncated && stepState.forceContinues < opts.maxForceContinues) {
            stepState.forceContinues++;
            stopped = false;
          }
          stepState.naturalStop = stopped;
          for (const p of opts.plugins) {
            if (p.hooks?.afterStop) {
              try {
                p.hooks.afterStop(!stopped, mutable.rt);
              } catch {
                /* plugin errors never affect the loop */
              }
            }
          }
          // Accepted-but-late steer: force one more turn to drain it.
          if (stepState.naturalStop && mutable.steerQueue.length > 0) {
            stepState.naturalStop = false;
          }
          break;
        } catch (err) {
          const providerAborted = err instanceof ProviderError && err.kind === "aborted";
          const stopRequested = mutable.controller?.signal.aborted === true;
          // Explicit stop/abort is a distinct terminal state.
          if (stopRequested || providerAborted) {
            mutable.status = "stopped";
            stepState.runError ??= err instanceof Error ? err.message : "stopped by user";
            await emit({ type: "agent_end", status: mutable.status });
            mutable.controller = null;
            return { status: mutable.status, usage: state.runUsage, error: stepState.runError };
          }
          // Overflow: one-shot compaction recovery inside the same turn.
          if (
            err instanceof ProviderError &&
            err.kind === "overflow" &&
            !stepState.overflowCompacted
          ) {
            stepState.overflowCompacted = true;
            stepState.usageAnchor = null;
            tokenEstimateCache.clear();
            await emit({ type: "compaction_start" });
            await compactSession(
              opts.store,
              opts.sessionId,
              opts.summarize,
              mutable.controller?.signal,
              opts.contextBudget,
            );
            await emit({ type: "compaction_end" });
            stepState.messages = await readBranchMessages(opts.store, opts.sessionId);
            continue; // retry model call in the SAME turn, no extra step
          }
          // Anything else is terminal: retryStream already applied its
          // bounded policy.
          stepState.runError ??= err instanceof Error ? err.message : String(err);
          mutable.status = "failed";
          await emit({ type: "agent_end", status: mutable.status });
          mutable.controller = null;
          return { status: mutable.status, usage: state.runUsage, error: stepState.runError };
        }
      }

      // afterModel hook: after the turn's output + tool results are
      // persisted, before turn_end.
      for (const p of opts.plugins) {
        if (p.hooks?.afterModel) {
          try {
            await p.hooks.afterModel(stepState.messages, mutable.rt);
          } catch {
            /* plugin errors never fail the run */
          }
        }
      }

      await emit({ type: "turn_end", turn: step });
      if (stepState.naturalStop) break;
    }

    return await finalizeLoop(bag, stepState, step, stepState.runError);
  } catch (err) {
    // Setup/persistence failure: settle to a terminal state so listeners
    // always receive agent_end and the loop is reusable.
    runError ??= err instanceof Error ? err.message : String(err);
    const wasAborted = mutable.controller?.signal.aborted === true;
    mutable.status = wasAborted ? "stopped" : "failed";
    const finalStatus = mutable.status as "completed" | "failed" | "stopped";
    await emit({ type: "agent_end", status: finalStatus });
    return { status: finalStatus, usage: state.runUsage, error: runError };
  } finally {
    mutable.active = false;
    mutable.controller = null;
    mutable.steerQueue.length = 0;
    mutable.acceptingSteer = false;
  }
}
