import type { BackendInputMessage, Usage } from "@my-agent-team/agent-backend";
import { debugLog } from "@my-agent-team/agent-backend";
import { ProviderError } from "@my-agent-team/ai";
import type { AIMessageChunk } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { SessionStore } from "../persistence/session-store.js";
import type { MessageEntry } from "../persistence/session-tree.js";
import type { AgentLoopListener, CodingAgentLoopEvent } from "./agent-event.js";
import { type CompactionBudget, compactSession } from "./compaction.js";
import type { CodingLoopInput } from "./loop-input.js";
import { buildLoopInput } from "./loop-input.js";
import { TokenEstimateCache } from "./message-cache.js";
import type { Plugin, PluginTool } from "./plugin.js";
import { collectTools, validatePlugins } from "./plugin.js";
import type { PluginRuntime } from "./plugin-runtime.js";
import { renderLoopMeta } from "./prompt.js";
import { retryStream } from "./retry.js";
import { buildTitleContext, generateTitle } from "./title.js";
import { type PruneConfig, pruneOldToolResults } from "./tool-pruning.js";

export type { AgentLoopListener, CodingAgentLoopEvent };

/** Thinking-mode effort, aligned with the provider's Anthropic config. */

interface PendingToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Summarizes covered messages into a compact context summary. Receives full
 *  Message objects (including tool_use/tool_result blocks) so tool semantics
 *  survive compaction. Injected by the caller (Phase 3 Worker uses
 *  ModelRuntime; tests inject a fake). */
export type ContextSummarizer = (
  messages: readonly Message[],
  signal?: AbortSignal,
) => Promise<string>;

/** Token-aware context budget for proactive compaction. Extends the compaction
 *  budget with a trigger ratio: compaction triggers when estimated tokens
 *  exceed limit * triggerRatio. Phase 3 injects a real model limit and token
 *  estimator; tests inject a simple char/4 proxy. */
export interface ContextBudget extends CompactionBudget {
  /** Compaction triggers when estimated tokens exceed limit * triggerRatio. */
  readonly triggerRatio: number;
}

export interface CodingAgentSessionOptions {
  readonly sessionId: string;
  readonly store: SessionStore;
  readonly plugins: readonly Plugin[];
  readonly maxSteps: number;
  readonly maxForceContinues: number;
  /** The model call for one turn. */
  readonly modelStream: (
    messages: readonly Message[],
    signal?: AbortSignal,
    /** Current tool table (static plugins + per-Run resolved tools). */
    tools?: readonly PluginTool[],
  ) => AsyncIterable<AIMessageChunk>;
  readonly summarize: ContextSummarizer;
  /** Resolve the model display identity for a run's model ref, used to render
   *  the per-loop Meta. Optional: when omitted (tests), Meta omits the model line. */
  readonly resolveModel?: (modelId: string) => Promise<{ provider: string; id: string }>;
  /** Resolve per-Run additional tools (e.g. the Product Tool manifest from
   *  `input.run.productTools`). Merged into the tool table at each runLoop
   *  start so snapshot changes apply on the next Run without a rebuild. */
  readonly resolveTools?: (input: CodingLoopInput) => Promise<readonly PluginTool[]>;
  /** Runtime capabilities injected into plugin hooks (model stream, store,
   *  workspace, emit). Optional: when omitted, hooks receive a stub with
   *  emit only (backward-compatible with pre-existing plugins). */
  readonly pluginRuntime?: PluginRuntime;
  readonly maxRetries?: number;
  /** Token-aware proactive compaction budget. When estimated context tokens
   *  exceed limit * triggerRatio before a model turn, compact once. Leave
   *  undefined to disable proactive compaction. */
  readonly contextBudget?: ContextBudget;
  /** Tool-output pruning config (). When set, old tool
   *  results outside the protect window are truncated to a summary before
   *  each model call — a lighter touch than full compaction. Protected
   *  tools (skills, plans) are never pruned. */
  readonly pruneConfig?: Partial<PruneConfig>;
}

/** Terminal result of a loop. `messages` is the canonical message sequence
 *  this Run produced (ADR 0017): assistant(tool_use) / tool(tool_result) /
 *  assistant(text) as separate messages in branch order — never merged into
 *  an assistant message. `usage` is the last usage chunk from the model
 *  stream; `error` is a redacted reason for failed/stopped outcomes. */
export interface CodingAgentLoopResult {
  readonly status: "completed" | "failed" | "stopped";
  readonly messages?: readonly Message[];
  readonly usage?: Usage;
  readonly error?: string;
  /** Auto-generated conversation title (first Run only; backend guards). */
  readonly title?: string;
}

export interface CodingAgentSession {
  readonly sessionId: string;
  readonly status: "idle" | "running" | "completed" | "failed" | "stopped";
  startLoop(input: CodingLoopInput): Promise<CodingAgentLoopResult>;
  startFollowUp(input: CodingLoopInput): Promise<CodingAgentLoopResult>;
  /** Inject a steer input into the active loop. No Meta, no new Loop: the
   *  message is queued and appended at the next safe boundary. */
  steer(input: BackendInputMessage): void;
  stop(): void;
  compact(): Promise<void>;
  onEvent(listener: AgentLoopListener): () => void;
  /** Emit a UI-transient event to all subscribers (for PluginRuntime). */
  emit(event: CodingAgentLoopEvent): void;
}

/** One model turn, accumulated purely from the stream
 *  streamAssistantResponse shape): raw outputs before any persistence. */
interface ModelTurn {
  readonly text: string;
  readonly thinking: string;
  readonly thinkingSignature?: string;
  readonly thinkingRedacted?: boolean;
  readonly toolCalls: readonly PendingToolCall[];
  readonly stopReason?: string;
}

export function createCodingAgentSession(opts: CodingAgentSessionOptions): CodingAgentSession {
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
  let status: "idle" | "running" | "completed" | "failed" | "stopped" = "idle";
  let runUsage: Usage | undefined;
  let active = false;
  let controller: AbortController | null = null;
  const steerQueue: BackendInputMessage[] = [];
  let acceptingSteer = false;
  let debugModelId = "";
  let debugTurn = 0;
  let debugRunId = "";
  const runIdForDebug = (): string => debugRunId;
  const tokenEstimateCache = new TokenEstimateCache();

  async function emit(event: CodingAgentLoopEvent): Promise<void> {
    for (const l of listeners) {
      try {
        await l(event);
      } catch {
        /* listener error is logged but not fatal */
      }
    }
  }

  function persist(entries: readonly Record<string, unknown>[]): Promise<unknown> {
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
    return [
      {
        type: "thinking",
        text: turn.thinkingRedacted ? "[reasoning redacted]" : turn.thinking,
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
  ): Promise<CodingAgentLoopResult> {
    if (active) throw new Error("Loop already active");
    active = true;
    status = "running";
    controller = new AbortController();
    // Bind rt.signal to THIS run's controller so plugin model calls
    // (recap/pet) honor stop()/abort().
    rt = {
      ...rt,
      signal: controller.signal,
      // Ephemeral side-channel turn: shares system prompt + branch messages
      // + tool catalog (for prompt cache) but never persists. Tool calls
      // from the model are discarded. Inspired by
      runEphemeralTurn: async (promptText, ephemeralOpts) => {
        const branch = await readBranchMessages();
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
    steerQueue.length = 0;
    debugModelId = codingInput.run.model.modelId;
    debugTurn = 0;
    debugRunId = codingInput.run.runId;
    runUsage = undefined;
    let runError: string | undefined;

    const runTools = opts.resolveTools ? await opts.resolveTools(codingInput) : [];
    toolMap = new Map([...baseTools, ...runTools].map((t) => [t.name, t]));

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
      await opts.store.appendBatch(opts.sessionId, built.batch);

      let messages = await readBranchMessages();
      let step = 0;
      let forceContinues = 0;
      let overflowCompacted = false;
      let thresholdCompacted = false;
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
          messages = await readBranchMessages();
          await emit({ type: "queue_update" });
        }

        // One step = at most one model call. Overflow recovery stays INSIDE
        while (true) {
          // Prune old tool-result content (): a lighter
          // pass that runs BEFORE compaction checks. Old results outside the
          // protect window are truncated to a summary; protected tools are
          // never pruned. May reduce context enough to avoid compaction
          // entirely (omp docs/compaction.md).
          const modelMessages0 = opts.pruneConfig
            ? pruneOldToolResults(messages, opts.pruneConfig).messages
            : messages;

          // Proactive (threshold) compaction. Token estimation is cached
          // per entry (our TokenEstimateCache): settled messages aren't
          // re-estimated every turn.
          if (opts.contextBudget && !thresholdCompacted) {
            const branch = await opts.store.readBranch(opts.sessionId);
            const msgEntries = branch.filter((e): e is MessageEntry => e.type === "message");
            const totalTokens = msgEntries.reduce(
              (sum, e) =>
                sum +
                tokenEstimateCache.estimate(e.entryId, e.message, opts.contextBudget!.estimate),
              0,
            );
            if (totalTokens > opts.contextBudget.limit * opts.contextBudget.triggerRatio) {
              thresholdCompacted = true;
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
              messages = await readBranchMessages();
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
            const turn = await streamModelTurn(modelMessages);
            const thinkingBlocks = buildThinkingBlock(turn);

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
              const toolResults = await executeTools(turn.toolCalls);

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
                    text: "",
                    blocks: [
                      ...thinkingBlocks,
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
                ...toolResults.map((result) => ({
                  type: "message" as const,
                  role: "tool" as const,
                  source: "tool_result" as const,
                  message: {
                    role: "tool",
                    text: JSON.stringify(result.result),
                    blocks: [
                      {
                        type: "tool_result" as const,
                        tool_use_id: result.id,
                        content: JSON.stringify(result.result),
                        ...(result.isError ? { is_error: true } : {}),
                      },
                    ],
                  } as Message,
                  createdAt: Date.now(),
                })),
              ];
              await persist(batch);

              messages = await readBranchMessages();
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
                    blocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
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
            // max_tokens truncation ( semantics): the model
            // ran out of output budget mid-answer — force one continuation
            // when capacity remains, bounded by maxForceContinues.
            if (
              stopped &&
              turn.stopReason === "max_tokens" &&
              forceContinues < opts.maxForceContinues
            ) {
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
              messages = await readBranchMessages();
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

        // afterModel hook (recap/pet): after the turn's output + tool
        // results are persisted, before turn_end.
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
      if (status === "completed" && process.env.CODING_AGENT_TITLE_ENABLED !== "0") {
        const titleBranch = await readBranchMessages();
        const titleCtx = buildTitleContext(titleBranch);
        if (titleCtx) {
          title = (await generateTitle(rt, titleCtx)) ?? undefined;
        }
      }

      await emit({ type: "agent_end", status });
      // Canonical output (ADR 0017): the run's full message sequence.
      let runMessages: readonly Message[] | undefined;
      if (status === "completed") {
        const entries = await opts.store.readBranch(opts.sessionId);
        runMessages = entries
          .filter(
            (e): e is MessageEntry =>
              e.type === "message" && (e.source === "assistant" || e.source === "tool_result"),
          )
          .map((e) => e.message);
      }
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

  /** Accumulate one model turn from the stream — pure, no persistence
   *  (). The caller decides what to persist. */
  async function streamModelTurn(messages: readonly Message[]): Promise<ModelTurn> {
    let text = "";
    let thinking = "";
    let thinkingSignature: string | undefined;
    let thinkingRedacted = false;
    const toolCallBuilders = new Map<string, { id: string; name: string; jsonParts: string[] }>();
    debugTurn++;
    debugLog(
      "coding-agent",
      `model_start runId=${runIdForDebug()} turn=${debugTurn} model=${debugModelId}`,
    );

    await emit({ type: "message_start" });
    const stream = retryStream(
      (signal) => opts.modelStream(messages, signal, [...toolMap.values()]),
      {
        maxAttempts: opts.maxRetries ?? 3,
        baseDelayMs: 1000,
        onRetryStart: (attempt) => emit({ type: "retry_start", attempt }),
        onRetryEnd: () => emit({ type: "retry_end" }),
      },
      controller?.signal,
    );

    let stopReason: string | undefined;
    try {
      for await (const chunk of stream) {
        if (controller?.signal.aborted) break;
        if (chunk.stopReason) stopReason = chunk.stopReason;
        if (chunk.usage) {
          // Accumulate across all model calls in the Run (not last-wins).
          runUsage = {
            inputTokens: (runUsage?.inputTokens ?? 0) + (chunk.usage.input ?? 0),
            outputTokens: (runUsage?.outputTokens ?? 0) + (chunk.usage.output ?? 0),
            cacheReadTokens: (runUsage?.cacheReadTokens ?? 0) + (chunk.usage.cacheRead ?? 0),
            cacheWriteTokens: (runUsage?.cacheWriteTokens ?? 0) + (chunk.usage.cacheCreate ?? 0),
          };
        }
        if (chunk.delta?.type === "text") {
          text += chunk.delta.text;
          await emit({ type: "message_update", text: chunk.delta.text });
        }
        if (chunk.delta?.type === "reasoning") {
          thinking += chunk.delta.text;
          await emit({ type: "thinking_update", text: chunk.delta.text });
        }
        if (chunk.delta?.type === "reasoning_signature") {
          thinkingSignature = chunk.delta.signature;
          thinkingRedacted = chunk.delta.redacted === true;
        }
        if (chunk.delta?.type === "tool_use") {
          const id = chunk.delta.id;
          if (!toolCallBuilders.has(id)) {
            toolCallBuilders.set(id, { id, name: chunk.delta.name, jsonParts: [] });
          }
        }
        if (chunk.delta?.type === "input_json_delta") {
          const builder = toolCallBuilders.get(chunk.delta.id);
          if (builder) builder.jsonParts.push(chunk.delta.partial_json);
        }
      }
    } finally {
      // message_end always pairs with message_start, even on failure/abort.
      await emit({ type: "message_end" });
    }
    debugLog(
      "coding-agent",
      `model_end runId=${runIdForDebug()} turn=${debugTurn} stopReason=${stopReason ?? "none"}`,
    );

    return {
      text,
      thinking,
      ...(thinkingSignature ? { thinkingSignature } : {}),
      ...(thinkingRedacted ? { thinkingRedacted: true } : {}),
      toolCalls: Array.from(toolCallBuilders.values()).map((b) => ({
        id: b.id,
        name: b.name,
        input: b.jsonParts.length > 0 ? safeParseJson(b.jsonParts.join("")) : {},
      })),
      stopReason,
    };
  }

  async function executeTools(
    calls: readonly PendingToolCall[],
  ): Promise<Array<{ id: string; result: unknown; isError: boolean; terminate: boolean }>> {
    const results: Array<{ id: string; result: unknown; isError: boolean; terminate: boolean }> =
      [];
    // Batch execution: consecutive concurrent tools run in parallel via
    // Promise.all; a serial tool acts as a barrier. Results preserve the
    // original tool-call order regardless of completion order.
    async function runOne(
      call: PendingToolCall,
    ): Promise<{ id: string; result: unknown; isError: boolean; terminate: boolean }> {
      const tool = toolMap.get(call.name);
      debugLog(
        "coding-agent",
        `tool_start runId=${runIdForDebug()} name=${call.name} callId=${call.id}`,
      );
      await emit({
        type: "tool_execution_start",
        toolName: call.name,
        kind: tool?.kind ?? "native",
        callId: call.id,
      });
      let result: unknown;
      let isError = false;
      let terminate = false;
      let input = call.input;
      if (tool) {
        // transformToolArgs: rewrite call args before execution
        // transformToolCallArguments).
        for (const p of opts.plugins) {
          if (p.hooks?.transformToolArgs) {
            try {
              const transformed = p.hooks.transformToolArgs(call.name, input, rt);
              if (transformed && typeof transformed === "object") {
                input = transformed as Record<string, unknown>;
              }
            } catch {
              /* plugin transform errors never block execution */
            }
          }
        }
        // beforeTool: observe or block (). A block
        // result emits an error tool result instead of executing.
        let blocked = false;
        let blockReason = `Blocked by plugin`;
        for (const p of opts.plugins) {
          if (p.hooks?.beforeTool) {
            try {
              const ret = p.hooks.beforeTool(call.name, input, rt);
              if (ret?.block) {
                blocked = true;
                if (ret.reason) blockReason = ret.reason;
                break;
              }
            } catch {
              /* plugin errors never block execution */
            }
          }
        }
        if (blocked) {
          result = { error: blockReason };
          isError = true;
        } else {
          try {
            result = await tool.execute(input, controller?.signal, { callId: call.id });
            if (result && typeof result === "object") {
              if ("isError" in result) {
                isError = Boolean((result as { isError?: unknown }).isError);
              }
              if ("terminate" in result) {
                terminate = Boolean((result as { terminate?: unknown }).terminate);
              }
            }
          } catch (err) {
            result = { error: err instanceof Error ? err.message : String(err) };
            isError = true;
          }
        }
      } else {
        result = { error: `Unknown tool: ${call.name}` };
        isError = true;
      }
      debugLog(
        "coding-agent",
        `tool_end runId=${runIdForDebug()} name=${call.name} callId=${call.id} error=${isError}`,
      );
      await emit({
        type: "tool_execution_end",
        toolName: call.name,
        kind: tool?.kind ?? "native",
        callId: call.id,
        result: (result ?? {}) as Readonly<Record<string, unknown>>,
      });
      // afterTool: observe (emit event) or patch (override result fields).
      for (const p of opts.plugins) {
        try {
          const ret = p.hooks?.afterTool?.(call.name, result, rt);
          if (ret) {
            // CodingAgentLoopEvent (has `type`) → emit; patch object →
            // override result fields field-by-field.
            if ("type" in ret) {
              await emit(ret);
            } else {
              if (ret.content !== undefined) result = ret.content;
              if (ret.isError !== undefined) isError = ret.isError;
              if (ret.terminate !== undefined) terminate = ret.terminate;
            }
          }
        } catch {
          /* plugin errors never affect the loop */
        }
      }
      return { id: call.id, result, isError, terminate };
    }

    let i = 0;
    while (i < calls.length) {
      if (controller?.signal.aborted) break;
      const call = calls[i]!;
      const isConcurrent = toolMap.get(call.name)?.executionMode === "concurrent";
      if (!isConcurrent) {
        // Serial tool: run alone (barrier before and after).
        if (controller?.signal.aborted) break;
        const r = await runOne(call);
        if (controller?.signal.aborted) break;
        results.push(r);
        i++;
        continue;
      }
      // Collect a maximal run of consecutive concurrent tools.
      const batch: PendingToolCall[] = [call];
      let j = i + 1;
      while (j < calls.length) {
        const next = calls[j]!;
        if (toolMap.get(next.name)?.executionMode !== "concurrent") break;
        batch.push(next);
        j++;
      }
      // Run the whole batch in parallel.
      const batchResults = await Promise.all(batch.map((c) => runOne(c)));
      if (controller?.signal.aborted) break;
      results.push(...batchResults);
      i = j;
    }
    return results;
  }

  async function readBranchMessages(): Promise<Message[]> {
    const entries = await opts.store.readBranch(opts.sessionId);

    // Find latest CompactionEntry
    let compactionSummary: string | null = null;
    let coveredIds: Set<string> | null = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]?.type === "compaction") {
        const comp = entries[i] as { summary: string; coversEntryIds: readonly string[] };
        compactionSummary = comp.summary;
        coveredIds = new Set(comp.coversEntryIds);
        break;
      }
    }

    return entries
      .filter((e) => {
        if (e.type !== "message") return false;
        // If compaction exists, skip covered entries
        if (coveredIds?.has(e.entryId)) return false;
        return true;
      })
      .map((e) => {
        const msg = (e as { message: Message }).message;
        // Prepend compaction summary as a system note if entries were compacted
        return msg;
      })
      .flatMap((msg, _i, _arr) => {
        // Insert summary as first user message if compaction applied
        if (_i === 0 && compactionSummary && coveredIds && coveredIds.size > 0) {
          return [
            { role: "user" as const, text: `[Context summary: ${compactionSummary}]` } as Message,
            msg,
          ];
        }
        return [msg];
      });
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

function safeParseJson(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
