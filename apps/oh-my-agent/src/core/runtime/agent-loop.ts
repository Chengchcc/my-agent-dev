import type { BackendInputMessage, Usage } from "@chengchenccc/agent-contract";
import { ProviderError } from "@chengchenccc/ai";
import type { Message } from "@chengchenccc/message";
import type { MessageEntry } from "../persistence/session-tree.js";
import type { AgentLoopListener, OmaLoopEvent } from "./agent-event.js";
import {
  executeTools,
  type LoopCallContext,
  type LoopRuntimeState,
  type LoopToolMapRef,
  readBranchMessages,
  streamModelTurn,
} from "./agent-loop-run.js";
import type {
  ModelTurn,
  OmaLoopResult,
  OmaSession,
  OmaSessionOptions,
} from "./agent-loop-types.js";
import { TOOL_FAILURE_REMINDER } from "./agent-loop-utils.js";
import { compactSession } from "./compaction.js";
import {
  estimateContextTokens,
  isSilentContextOverflow,
  type UsageAnchor,
  usageTotalTokens,
} from "./context-estimate.js";
import type { CodingLoopInput } from "./loop-input.js";
import { buildLoopInput } from "./loop-input.js";
import { TokenEstimateCache } from "./message-cache.js";
import { collectTools, validatePlugins } from "./plugin.js";
import type { PluginRuntime } from "./plugin-runtime.js";
import { renderLoopMeta } from "./prompt.js";
import { buildTitleContext, generateTitle } from "./title.js";
import { pruneOldToolResults } from "./tool-pruning.js";

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
  let toolMap = new Map(baseTools.map((t) => [t.name, t]));
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

  /** One thinking block from a turn's raw thinking (single assembly point:
   *  both the text turn and the tool turn persist through here). An empty
   *  thinking text with a signature (display: "omitted") still persists
   *  the signature must be replayed unchanged in tool-use turns. */
  function buildThinkingBlock(
    turn: ModelTurn,
  ): Array<{ type: "thinking"; text: string; signature?: string; redacted?: boolean }> {
    if (!turn.thinking && !turn.thinkingSignature) return [];
    // Collapse the interleaved thinking strands into one thinking block for
    // replay: Anthropic requires a single <thinking> per assistant message,
    // and signature/redacted attach at the end. Text passages stay in the
    // ordered blocks when the turn persists them (tool turns keep them).
    const text = turn.thinkingRedacted ? "[reasoning redacted]" : turn.thinking;
    return [
      {
        type: "thinking",
        text,
        ...(turn.thinkingSignature ? { signature: turn.thinkingSignature } : {}),
        ...(turn.thinkingRedacted ? { redacted: true } : {}),
      },
    ];
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
  async function runLoop(
    codingInput: CodingLoopInput,
    mode: "normal" | "follow_up",
  ): Promise<OmaLoopResult> {
    if (active) throw new Error("Loop already active");
    active = true;
    status = "running";
    controller = new AbortController();
    // Bind rt.signal to THIS run's controller so plugin model calls
    // (side-channel summaries) honor stop()/abort().
    rt = {
      ...rt,
      signal: controller.signal,
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
          ephemeralOpts?.signal ?? controller?.signal,
          [...toolMap.values()],
        )) {
          if (chunk.delta?.type === "text") text += chunk.delta.text;
        }
        return text;
      },
    };
    streamRuleInjections.clear();
    debugModelId = codingInput.run.model.modelId;
    debugTurn = 0;
    debugRunId = codingInput.run.runId;
    runUsage = undefined;
    let runError: string | undefined;

    const runTools = opts.resolveTools ? await opts.resolveTools(codingInput) : [];
    toolMap = new Map([...baseTools, ...runTools].map((t) => [t.name, t]));
    toolMapRef.current = toolMap;

    await emit({ type: "agent_start" });

    try {
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

      let messages = await readBranchMessages(opts.store, opts.sessionId);
      let step = 0;
      let forceContinues = 0;
      let overflowCompacted = false;
      let thresholdCompacted = false;
      let usageAnchor: UsageAnchor | null = null;
      let naturalStop = false;

      for (const p of opts.plugins) {
        if (p.hooks?.beforeRun) {
          try {
            await p.hooks.beforeRun(messages, rt);
          } catch {
            /* plugin setup errors never fail the run */
          }
        }
      }

      while (step < opts.maxSteps && !naturalStop) {
        if (controller?.signal.aborted) break;
        step++;
        acceptingSteer = step < opts.maxSteps;

        // Drain steer queue at safe boundary (steer appends only the input
        // message — no Meta, no new Loop).
        if (steerQueue.length > 0) {
          const steers = steerQueue.splice(0);
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
          messages = await readBranchMessages(opts.store, opts.sessionId);
          const drained = steers
            .map((s) => (s.message.role === "user" ? (s.message.text ?? "") : ""))
            .filter((t) => t.length > 0);
          await emit({
            type: "queue_update",
            ...(drained.length > 0 ? { drained } : {}),
          });
        }

        // One step = at most one model call. Overflow recovery stays INSIDE
        while (true) {
          // Prune old tool-result content: a lighter
          // pass that runs BEFORE compaction checks. Old results outside the
          // protect window are truncated to a summary; protected tools are
          // never pruned. May reduce context enough to avoid compaction
          // entirely (omp docs/compaction.md).
          const modelMessages0 = opts.pruneConfig
            ? pruneOldToolResults(messages, opts.pruneConfig).messages
            : messages;

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
            if (!thresholdCompacted) {
              const totalTokens = estimateContextTokens(msgEntries, usageAnchor, (e) =>
                tokenEstimateCache.estimate(e.entryId, e.message, opts.contextBudget!.estimate),
              );
              if (totalTokens > opts.contextBudget.limit * opts.contextBudget.triggerRatio) {
                thresholdCompacted = true;
                usageAnchor = null;
                tokenEstimateCache.clear();
                await emit({ type: "compaction_start" });
                await compactSession(
                  opts.store,
                  opts.sessionId,
                  opts.summarize,
                  controller?.signal,
                  opts.contextBudget,
                );
                await emit({ type: "compaction_end" });
                messages = await readBranchMessages(opts.store, opts.sessionId);
              }
            }
          }

          // beforeModel hook.
          const transformed = [...modelMessages0];
          for (const p of opts.plugins) {
            if (p.hooks?.beforeModel) {
              const result = p.hooks.beforeModel(transformed, rt);
              transformed.length = 0;
              transformed.push(...result);
            }
          }

          try {
            const modelMessages = systemPrompt
              ? [{ role: "system", text: systemPrompt } as Message, ...transformed]
              : transformed;
            const turn = await streamModelTurn(callCtx(), modelMessages);
            const thinkingBlocks = buildThinkingBlock(turn);
            // Usage anchor (oh-my-pi): the completed call's real token
            // total is authoritative for everything persisted before the
            // call — per-message estimation covers only the delta since.
            if (turn.usage && usageTotalTokens(turn.usage) > 0) {
              usageAnchor = { afterEntryId: callBoundaryId, tokens: usageTotalTokens(turn.usage) };
            }
            // Silent context overflow (oh-my-pi isContextOverflow): some
            // providers (zai, Xiaomi-style) accept an oversized request
            // instead of erroring. Same recovery as the error path: one-shot
            // compaction, then retry the model call in the SAME turn.
            if (
              opts.contextBudget &&
              !overflowCompacted &&
              !controller?.signal.aborted &&
              isSilentContextOverflow(turn.usage, turn.stopReason, opts.contextBudget.limit)
            ) {
              overflowCompacted = true;
              usageAnchor = null;
              tokenEstimateCache.clear();
              await emit({ type: "compaction_start" });
              await compactSession(
                opts.store,
                opts.sessionId,
                opts.summarize,
                controller?.signal,
                opts.contextBudget,
              );
              await emit({ type: "compaction_end" });
              messages = await readBranchMessages(opts.store, opts.sessionId);
              continue;
            }
            // TTSR stream-rule hit: discard the partial turn (nothing was
            // persisted — accumulation is pre-persistence by design),
            // inject the rule as a hidden system reminder, and retry the
            // model call in the SAME turn (bounded per rule by
            // maxInjections, so the extra model calls ≤ rule count).
            if (turn.streamRuleHit) {
              const rule = turn.streamRuleHit;
              streamRuleInjections.set(rule.name, (streamRuleInjections.get(rule.name) ?? 0) + 1);
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
              messages = await readBranchMessages(opts.store, opts.sessionId);
              continue;
            }

            if (turn.toolCalls.length > 0) {
              // Stop-during-stream: signal aborted before we persist anything.
              // Do not write a dangling tool_use — it would corrupt the branch
              // on resume (API 400 for unpaired tool_use).
              if (controller?.signal.aborted) {
                status = "stopped";
                await emit({ type: "agent_end", status });
                controller = null;
                return { status, usage: runUsage, error: "stopped by user" };
              }

              // Execute tools FIRST, then persist assistant + results in ONE
              // batch. This ensures the tree never has a tool_use without a
              // matching tool_result — even if stop fires during execution,
              // the batch either fully writes or doesn't write at all.
              const toolResults = await executeTools(callCtx(), turn.toolCalls);

              if (controller?.signal.aborted) {
                status = "stopped";
                await emit({ type: "agent_end", status });
                controller = null;
                return { status, usage: runUsage, error: "stopped by user" };
              }

              // Persist assistant(tool_use) + all tool_results atomically.
              const batch: Array<{
                type: "message";
                role: "assistant" | "tool";
                source: string;
                message: Message;
                createdAt: number;
              }> = [
                {
                  type: "message",
                  role: "assistant",
                  source: "assistant",
                  message: {
                    role: "assistant",
                    // Keep any narrative text the model emitted alongside
                    // tool calls (DeepSeek interleaves thinking/text with
                    // tool_use). Text fragments preserve their order; thinking
                    // fragments COLLAPSE into the single thinking block
                    // (Anthropic requires one <thinking> per assistant message
                    // with one signature) inserted at the position of the
                    // first thinking fragment.
                    text: turn.text,
                    blocks: [
                      ...(() => {
                        const collapsedThinking = {
                          type: "thinking" as const,
                          text: turn.thinkingRedacted ? "[reasoning redacted]" : turn.thinking,
                          ...(turn.thinkingSignature ? { signature: turn.thinkingSignature } : {}),
                          ...(turn.thinkingRedacted ? { redacted: true } : {}),
                        };
                        const out: Array<{ type: string; text: string }> = [];
                        let thinkingInserted = false;
                        for (const b of turn.ordered) {
                          if (b.type === "thinking") {
                            if (!thinkingInserted) {
                              out.push(collapsedThinking);
                              thinkingInserted = true;
                            }
                            continue;
                          }
                          out.push(b);
                        }
                        if (!thinkingInserted && turn.thinking) {
                          out.push(collapsedThinking);
                        }
                        return out;
                      })(),
                      ...turn.toolCalls.map((tc) => ({
                        type: "tool_use" as const,
                        id: tc.id,
                        name: tc.name,
                        input: tc.input,
                      })),
                    ],
                  } as Message,
                  createdAt: Date.now(),
                },
                ...toolResults.map((result) => {
                  // Vision passthrough: a tool result carrying `images`
                  // (read_image) keeps them on the tool_result block so
                  // providers map them onto the wire content array.
                  const imgs = (result.result as { images?: unknown } | null | undefined)?.images;
                  const images =
                    Array.isArray(imgs) && imgs.length > 0
                      ? {
                          images: imgs as Message["blocks"],
                        }
                      : {};
                  // Tool result content contract (spec): a string `content`
                  // field is the model-visible text verbatim (tool-formatted);
                  // everything else stays the JSON dump for both model and UI.
                  const res = result.result as { content?: unknown } | null | undefined;
                  const raw =
                    typeof res?.content === "string" ? res.content : JSON.stringify(result.result);
                  // Tool-failure system reminder (absorbed from oh-my-pi):
                  // in-band on the failing result so it survives into the
                  // canonical ledger — "the fix sticks" across runs. The
                  // message `text` stays the clean JSON for UI display.
                  const content =
                    result.isError && opts.toolFailureReminder !== false
                      ? `${TOOL_FAILURE_REMINDER}\n\n${raw}`
                      : raw;
                  return {
                    type: "message" as const,
                    role: "tool" as const,
                    source: "tool_result" as const,
                    message: {
                      role: "tool",
                      text: raw,
                      blocks: [
                        {
                          type: "tool_result" as const,
                          tool_use_id: result.id,
                          content,
                          ...(result.isError ? { is_error: true } : {}),
                          ...images,
                        },
                      ],
                    } as Message,
                    createdAt: Date.now(),
                  };
                }),
              ];
              await persist(batch);

              messages = await readBranchMessages(opts.store, opts.sessionId);
              if (toolResults.some((r) => r.terminate) && steerQueue.length === 0) {
                naturalStop = true;
              }
              break;
            }

            // Text turn: persist assistant(text) + thinking. Thinking alone
            // is not a message — a thinking-only turn with no text and no
            // tool calls contributed nothing replayable, and empty content
            // breaks strict model APIs.
            // An abort during the stream discards the partial output: an
            // uncompleted turn never enters the canonical tree.
            if (turn.text && !controller?.signal.aborted) {
              await persist([
                {
                  type: "message",
                  role: "assistant",
                  source: "assistant",
                  message: {
                    role: "assistant",
                    text: turn.text,
                    // Preserve the interleaved thinking/text order from the
                    // stream. The single collapsed thinking block (with
                    // signature) is still emitted for replay compatibility
                    // when the stream had a signature, but the ordered list
                    // keeps the trace faithful.
                    blocks:
                      turn.ordered.length > 0
                        ? turn.ordered.map((b) =>
                            b.type === "thinking"
                              ? {
                                  type: "thinking" as const,
                                  text: turn.thinkingRedacted ? "[reasoning redacted]" : b.text,
                                  ...(turn.thinkingSignature
                                    ? { signature: turn.thinkingSignature }
                                    : {}),
                                  ...(turn.thinkingRedacted ? { redacted: true } : {}),
                                }
                              : b,
                          )
                        : thinkingBlocks.length > 0
                          ? thinkingBlocks
                          : undefined,
                  },
                  createdAt: Date.now(),
                },
              ]);
            }

            // Natural stop: let plugins veto.
            let stopped = true;
            for (const p of opts.plugins) {
              if (p.hooks?.beforeStop) {
                let vetoed = false;
                try {
                  p.hooks.beforeStop(() => {
                    vetoed = true;
                  }, rt);
                } catch {
                  /* plugin errors never fail the run */
                }
                if (vetoed && forceContinues < opts.maxForceContinues) {
                  forceContinues++;
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
            if (stopped && truncated && forceContinues < opts.maxForceContinues) {
              forceContinues++;
              stopped = false;
            }
            naturalStop = stopped;
            for (const p of opts.plugins) {
              if (p.hooks?.afterStop) {
                try {
                  p.hooks.afterStop(!stopped, rt);
                } catch {
                  /* plugin errors never affect the loop */
                }
              }
            }
            // Accepted-but-late steer: force one more turn to drain it.
            if (naturalStop && steerQueue.length > 0) {
              naturalStop = false;
            }
            break;
          } catch (err) {
            // Explicit stop/abort is a distinct terminal state.
            if (
              controller?.signal.aborted ||
              (err instanceof ProviderError && err.kind === "aborted")
            ) {
              status = "stopped";
              runError ??= err instanceof Error ? err.message : "stopped by user";
              await emit({ type: "agent_end", status });
              controller = null;
              return { status, usage: runUsage, error: runError };
            }
            // Overflow: one-shot compaction recovery inside the same turn.
            if (err instanceof ProviderError && err.kind === "overflow" && !overflowCompacted) {
              overflowCompacted = true;
              usageAnchor = null;
              tokenEstimateCache.clear();
              await emit({ type: "compaction_start" });
              await compactSession(
                opts.store,
                opts.sessionId,
                opts.summarize,
                controller?.signal,
                opts.contextBudget,
              );
              await emit({ type: "compaction_end" });
              messages = await readBranchMessages(opts.store, opts.sessionId);
              continue; // retry model call in the SAME turn, no extra step
            }
            // Anything else is terminal: retryStream already applied its
            // bounded policy.
            runError ??= err instanceof Error ? err.message : String(err);
            status = "failed";
            await emit({ type: "agent_end", status });
            controller = null;
            return { status, usage: runUsage, error: runError };
          }
        }

        // afterModel hook: after the turn's output + tool results are
        // persisted, before turn_end.
        for (const p of opts.plugins) {
          if (p.hooks?.afterModel) {
            try {
              await p.hooks.afterModel(messages, rt);
            } catch {
              /* plugin errors never fail the run */
            }
          }
        }

        await emit({ type: "turn_end", turn: step });
        if (naturalStop) break;
      }

      if (controller?.signal.aborted) {
        status = "stopped";
      } else if (!naturalStop && step >= opts.maxSteps && status === "running") {
        status = "failed";
        runError ??= `max steps exceeded (${opts.maxSteps})`;
      } else if (status === "running") {
        status = "completed";
      }

      for (const p of opts.plugins) {
        if (p.hooks?.afterRun) {
          try {
            await p.hooks.afterRun(status as "completed" | "failed" | "stopped", messages, rt);
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
        status === "completed" &&
        process.env.OMA_CONV_TITLED !== "1" &&
        process.env.OMA_TITLE_ENABLED !== "0"
      ) {
        const titleBranch = await readBranchMessages(opts.store, opts.sessionId);
        const titleCtx = buildTitleContext(titleBranch);
        if (titleCtx) {
          title = (await generateTitle(rt, titleCtx)) ?? undefined;
        }
      }

      await emit({ type: "agent_end", status });
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
      return { status, messages: runMessages, usage: runUsage, error: runError, title };
    } catch (err) {
      // Setup/persistence failure: settle to a terminal state so listeners
      // always receive agent_end and the loop is reusable.
      runError ??= err instanceof Error ? err.message : String(err);
      status = controller?.signal.aborted ? "stopped" : "failed";
      await emit({ type: "agent_end", status });
      return { status, usage: runUsage, error: runError };
    } finally {
      active = false;
      controller = null;
      steerQueue.length = 0;
      acceptingSteer = false;
    }
  }

  return {
    sessionId: opts.sessionId,
    get status() {
      return status;
    },

    async startLoop(deps) {
      return runLoop(deps, "normal");
    },

    async startFollowUp(deps) {
      return runLoop(deps, "follow_up");
    },
    steer(input: BackendInputMessage) {
      if (status !== "running" || !acceptingSteer) {
        throw new Error("Steer is only accepted during a loop with remaining turn capacity");
      }
      steerQueue.push(input);
    },

    stop() {
      controller?.abort();
    },
    async compact() {
      await emit({ type: "compaction_start" });
      await compactSession(
        opts.store,
        opts.sessionId,
        opts.summarize,
        controller?.signal,
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
