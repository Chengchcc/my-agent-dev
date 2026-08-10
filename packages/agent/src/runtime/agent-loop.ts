import type { BackendInputMessage, Usage } from "@my-agent-team/agent-backend";
import { debugLog } from "@my-agent-team/agent-backend";
import { ProviderError } from "@my-agent-team/ai";
import type { AIMessageChunk } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { SessionStore } from "../persistence/session-store.js";
import type { AgentLoopListener, CodingAgentLoopEvent } from "./agent-event.js";
import { type CompactionBudget, compactSession } from "./compaction.js";
import type { CodingLoopInput } from "./loop-input.js";
import { buildLoopInput } from "./loop-input.js";
import type { Plugin, PluginTool } from "./plugin.js";
import { collectTools, validatePlugins } from "./plugin.js";
import type { PluginRuntime } from "./plugin-runtime.js";
import { renderLoopMeta } from "./prompt.js";
import { retryStream } from "./retry.js";
import { buildTitleContext, generateTitle } from "./title.js";

export type { AgentLoopListener, CodingAgentLoopEvent };

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
  readonly modelStream: (
    messages: readonly Message[],
    signal?: AbortSignal,
    /** Current tool table (static plugins + per-Run resolved tools), so the
     *  provider can advertise the schemas to the model. */
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
}

/** A Coding Agent Session owns the store, plugins, listeners, and lifecycle.
 *  Each call to startLoop/startFollowUp creates a one-shot internal loop; the
 *  session itself is the long-lived controller. */
/** Terminal result of a loop. `output` is the canonical persisted assistant
 *  Message (blocks + tool pairs), not a reconstruction from deltas; `usage` is
 *  the last usage chunk from the model stream; `error` is a redacted reason
 *  for failed/stopped outcomes. */
export interface CodingAgentLoopResult {
  readonly status: "completed" | "failed" | "stopped";
  readonly output?: Message;
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
    runEphemeralTurn: async () => "",
  };
  // Static plugin tools + per-run resolved tools (Product Tool manifest).
  // The tool table is rebuilt at each runLoop start so AgentRunSnapshot
  // changes (productTools) take effect on the next Run without a rebuild.
  const baseTools = collectTools(opts.plugins);
  let toolMap = new Map(baseTools.map((t) => [t.name, t]));
  let status: "idle" | "running" | "completed" | "failed" | "stopped" = "idle";
  // Per-run usage accumulated from model chunks (session scope so both runLoop
  // and processModelTurn can read/write it).
  let runUsage: Usage | undefined;
  // Active-loop ownership is separate from terminal status: the loop is
  // "active" from startLoop until listeners settle in finally. This prevents
  // a concurrent startFollowUp from racing with agent_end listeners.
  let active = false;
  let controller: AbortController | null = null;
  const steerQueue: BackendInputMessage[] = [];
  let acceptingSteer = false;
  // Debug diagnostics: which model runs this loop, and the per-turn counter.
  let debugModelId = "";
  let debugTurn = 0;
  let debugRunId = "";
  const runIdForDebug = (): string => debugRunId;

  async function emit(event: CodingAgentLoopEvent): Promise<void> {
    for (const l of listeners) {
      try {
        await l(event);
      } catch {
        /* listener error is logged but not fatal */
      }
    }
  }

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
      // from the model are discarded. Inspired by omp's runEphemeralTurn.
      runEphemeralTurn: async (promptText, ephemeralOpts) => {
        const branch = await readBranchMessages();
        const ephemeralMessages: Message[] = [
          ...((codingInput.run.systemPrompt ?? "") ? [{ role: "system" as const, text: codingInput.run.systemPrompt ?? "" }] : []),
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
    // Reset per-run: a Run without usage must not inherit the previous Run's.
    runUsage = undefined;
    let runError: string | undefined;

    // Per-Run tool resolution: static plugins + this run's resolved tools
    // (Product Tool manifest). Snapshot changes take effect on the next Run.
    const runTools = opts.resolveTools ? await opts.resolveTools(codingInput) : [];
    toolMap = new Map([...baseTools, ...runTools].map((t) => [t.name, t]));

    await emit({ type: "agent_start" });

    try {
      // The Session is the sole Meta owner: it renders the per-loop Meta
      // Message from run/workspace/plugin state (never passed across the
      // Backend boundary). systemPrompt comes from the run snapshot.
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

      // Read branch for model messages
      let messages = await readBranchMessages();

      let step = 0;
      let forceContinues = 0;
      let overflowCompacted = false;
      let thresholdCompacted = false;
      let naturalStop = false;

      // beforeRun: one-shot per-Run hook. Fires after agent_start + messages
      // are loaded, before the first model turn. Symmetric with afterRun.
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
        // Steer is accepted only when there's capacity for at least one more
        // safe-boundary turn after the current one.
        acceptingSteer = step < opts.maxSteps;

        // Drain steer queue at safe boundary. Steer appends only the input
        // message (source=steer) - no Meta, no new Loop.
        if (steerQueue.length > 0) {
          const steers = steerQueue.splice(0);
          await opts.store.appendBatch(opts.sessionId, {
            entries: steers.map((s) => ({
              type: "message",
              productEntryId: s.productEntryId ?? null,
              role: s.message.role as "user" | "assistant" | "system",
              source: "steer",
              message: s.message,
              createdAt: Date.now(),
            })),
          });
          messages = await readBranchMessages();
          await emit({ type: "queue_update" });
        }

        // One turn = one model call. Overflow recovery (compact + retry) stays
        // INSIDE this turn and never consumes an extra maxStep. Provider
        // retry is owned solely by retryStream with its bounded policy; any
        // error escaping it (retries exhausted, auth, invalid, fatal, aborted)
        // is terminal here.
        while (true) {
          // Proactive (threshold) compaction: if the branch grew past the
          // configured threshold, compact once before the model turn. Shares
          // the one compaction implementation with manual/overflow triggers.
          if (opts.contextBudget && !thresholdCompacted) {
            const branch = await opts.store.readBranch(opts.sessionId);
            const msgEntries = branch.filter((e) => e.type === "message") as Array<{
              message: Message;
            }>;
            const totalTokens = msgEntries.reduce(
              (sum, e) => sum + opts.contextBudget!.estimate(e.message),
              0,
            );
            if (totalTokens > opts.contextBudget.limit * opts.contextBudget.triggerRatio) {
              thresholdCompacted = true;
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
          // beforeModel hook
          const transformed = [...messages];
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
            const toolCalls = await processModelTurn(modelMessages);
            if (toolCalls.length > 0) {
              // Tool calls: execute and continue to the next turn
              const toolResults = await executeTools(toolCalls);

              // stop() during tool execution: do not persist partial results,
              // transition straight to the stopped terminal state.
              if (controller?.signal.aborted) {
                status = "stopped";
                await emit({ type: "agent_end", status });
                controller = null;
                return { status, usage: runUsage, error: "stopped by user" };
              }

              // Persist assistant tool_use message
              await opts.store.appendBatch(opts.sessionId, {
                entries: [
                  {
                    type: "message",
                    role: "assistant",
                    source: "assistant",
                    message: {
                      role: "assistant",
                      text: "",
                      blocks: toolCalls.map((tc) => ({
                        type: "tool_use",
                        id: tc.id,
                        name: tc.name,
                        input: tc.input,
                      })),
                    },
                    createdAt: Date.now(),
                  },
                ],
              });

              // Persist tool results
              for (const result of toolResults) {
                await opts.store.appendBatch(opts.sessionId, {
                  entries: [
                    {
                      type: "message",
                      role: "tool",
                      source: "tool_result",
                      message: {
                        role: "tool",
                        text: JSON.stringify(result.result),
                        blocks: [
                          {
                            type: "tool_result",
                            tool_use_id: result.id,
                            content: JSON.stringify(result.result),
                            ...(result.isError ? { is_error: true } : {}),
                          },
                        ],
                      },
                      createdAt: Date.now(),
                    },
                  ],
                });
              }

              messages = await readBranchMessages();
              // Tool terminate hint: any tool may ask the loop to stop after
              // this turn's results are persisted (no further model turns).
              if (toolResults.some((r) => r.terminate) && steerQueue.length === 0) {
                naturalStop = true;
              }
              break; // tool turn complete -> next step
            }

            // Natural stop: let plugins veto
            let stopped = true;
            for (const p of opts.plugins) {
              if (p.hooks?.beforeStop) {
                let vetoed = false;
                p.hooks.beforeStop(() => {
                  vetoed = true;
                }, rt);
                if (vetoed && forceContinues < opts.maxForceContinues) {
                  forceContinues++;
                  stopped = false;
                  break;
                }
              }
            }
            naturalStop = stopped;
            // afterStop: notify plugins of the decision (vetoed = forced continue).
            for (const p of opts.plugins) {
              if (p.hooks?.afterStop) {
                try {
                  p.hooks.afterStop(!stopped, rt);
                } catch {
                  /* plugin errors never affect the loop */
                }
              }
            }
            // Accepted-but-late steer: if a steer arrived during this model
            // turn and the model chose to stop naturally, do NOT discard the
            // steer. Force one more safe-boundary turn to drain it.
            if (naturalStop && steerQueue.length > 0) {
              naturalStop = false;
            }
            break;
          } catch (err) {
            // Explicit stop/abort is a distinct terminal state
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
            // Overflow: one-shot compaction recovery inside the same turn
            if (err instanceof ProviderError && err.kind === "overflow" && !overflowCompacted) {
              overflowCompacted = true;
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
            // Anything else (retries exhausted, auth, invalid_request, fatal)
            // is terminal: the loop is the only retry owner and retryStream
            // already applied its bounded policy.
            runError ??= err instanceof Error ? err.message : String(err);
            status = "failed";
            await emit({ type: "agent_end", status });
            controller = null;
            return { status, usage: runUsage, error: runError };
          }
        }

        // afterModel hook: plugins may stream a cheap model (recap/pet) or
        // emit UI-transient events. Called after the turn's model output +
        // tool results are persisted, before turn_end.
        for (const p of opts.plugins) {
          if (p.hooks?.afterModel) {
            await p.hooks.afterModel(messages, rt);
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

      // afterRun: one-shot per-Run hook (recap). Fires once with the full
      // message history + terminal status, before agent_end. Cheaper than
      // afterModel (once per Run, not per turn). Skipped on early-exit
      // error paths inside the loop (stop-during-tools, fatal model error).
      for (const p of opts.plugins) {
        if (p.hooks?.afterRun) {
          try {
            await p.hooks.afterRun(status as "completed" | "failed" | "stopped", messages, rt);
          } catch {
            /* plugin errors never fail the run */
          }
        }
      }

      // Auto-generate conversation title (first Run; backend's !title guard
      // deduplicates). Uses the Run's model — one cheap call per completed Run.
      let title: string | undefined;
      if (status === "completed" && process.env.CODING_AGENT_TITLE_ENABLED !== "0") {
        const titleBranch = await readBranchMessages();
        const titleCtx = buildTitleContext(titleBranch);
        if (titleCtx) {
          title = (await generateTitle(rt, titleCtx)) ?? undefined;
        }
      }

      await emit({ type: "agent_end", status });
      // Canonical output: the last assistant text + ALL tool_use/tool_result
      // blocks from the Run branch. Without merging tool blocks, only the
      // final text survives in the ledger — tool steps vanish on refresh.
      let output: Message | undefined;
      if (status === "completed") {
        const branch = await readBranchMessages();
        const lastAssistant = [...branch].reverse().find((m) => m.role === "assistant");
        if (lastAssistant) {
          const toolBlocks = branch
            .filter((m) => m.role === "assistant" || m.role === "tool")
            .flatMap((m) => m.blocks ?? [])
            .filter((b) => b.type === "tool_use" || b.type === "tool_result");
          output = {
            ...lastAssistant,
            blocks: [...(lastAssistant.blocks ?? []), ...toolBlocks],
          };
        }
      }
      return { status, output, usage: runUsage, error: runError, title };
    } catch (err) {
      // Setup/persistence failure: the loop must settle to a terminal state
      // so listeners always receive agent_end and the loop is reusable.
      runError ??= err instanceof Error ? err.message : String(err);
      status = controller?.signal.aborted ? "stopped" : "failed";
      await emit({ type: "agent_end", status });
      return { status, usage: runUsage, error: runError };
    } finally {
      // Active-loop ownership must be released on EVERY exit path (normal,
      // early return, throw) so the session is reusable.
      active = false;
      controller = null;
      steerQueue.length = 0;
      acceptingSteer = false;
    }
  }

  async function processModelTurn(messages: readonly Message[]): Promise<PendingToolCall[]> {
    let assistantText = "";
    const toolCallBuilders = new Map<string, { id: string; name: string; jsonParts: string[] }>();
    debugTurn++;
    debugLog(
      "coding-agent",
      `model_start runId=${runIdForDebug()} turn=${debugTurn} model=${debugModelId}`,
    );

    await emit({ type: "message_start" });
    const stream = retryStream(
      // The tool table is re-read each turn so per-Run tools (Product
      // Tools) from the latest resolveTools() are advertised to the model.
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
          assistantText += chunk.delta.text;
          await emit({ type: "message_update", text: chunk.delta.text });
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

    // Aborted mid-stream: discard partial output — an uncompleted turn must
    // not enter the canonical Coding Session Tree (same as tool cancellation).
    if (controller?.signal.aborted) {
      return [];
    }

    // Persist assistant text if any
    if (assistantText) {
      await opts.store.appendBatch(opts.sessionId, {
        entries: [
          {
            type: "message",
            role: "assistant",
            source: "assistant",
            message: { role: "assistant", text: assistantText },
            createdAt: Date.now(),
          },
        ],
      });
    }

    // Build pending tool calls with parsed input
    return Array.from(toolCallBuilders.values()).map((b) => ({
      id: b.id,
      name: b.name,
      input: b.jsonParts.length > 0 ? safeParseJson(b.jsonParts.join("")) : {},
    }));
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
      if (tool) {
        // beforeTool: plugins can observe/log before execution.
        for (const p of opts.plugins) {
          if (p.hooks?.beforeTool) {
            try {
              p.hooks.beforeTool(call.name, call.input, rt);
            } catch {
              /* plugin errors never block execution */
            }
          }
        }
        try {
          result = await tool.execute(call.input, controller?.signal, { callId: call.id });
          if (result && typeof result === "object") {
            if ("isError" in result) {
              isError = Boolean((result as { isError?: unknown }).isError);
            }
            // Tool terminate hint: the tool asks the loop to stop after this
            // turn's results are persisted (no further model turns).
            if ("terminate" in result) {
              terminate = Boolean((result as { terminate?: unknown }).terminate);
            }
          }
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
          isError = true;
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
      // Plugin hooks may surface UI-transient events (e.g. todo_update);
      // emitted after the tool result so consumers get the final payload.
      for (const p of opts.plugins) {
        const ev = p.hooks?.afterTool?.(call.name, result, rt);
        if (ev) await emit(ev);
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
