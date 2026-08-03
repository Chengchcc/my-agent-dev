import { ProviderError } from "@my-agent-team/ai";
import type { AIMessageChunk } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { SessionStore } from "../persistence/session-store.js";
import type { AgentLoopListener, CodingAgentLoopEvent } from "./agent-event.js";
import { compactSession } from "./compaction.js";
import type { LoopInputDeps } from "./loop-input.js";
import { buildLoopInput } from "./loop-input.js";
import type { Plugin } from "./plugin.js";
import { collectTools, validatePlugins } from "./plugin.js";
import { retryStream } from "./retry.js";

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

/** Token-aware context budget for proactive compaction. Phase 3 injects a
 *  real model limit and token estimator; tests inject a simple char/4 proxy. */
export interface ContextBudget {
  /** Estimate token cost of a single message (first version: chars/4). */
  estimate(message: Message): number;
  /** Maximum token budget for the active context window. */
  limit: number;
  /** Compaction triggers when estimated tokens exceed limit * triggerRatio. */
  triggerRatio: number;
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
  ) => AsyncIterable<AIMessageChunk>;
  readonly summarize: ContextSummarizer;
  readonly maxRetries?: number;
  /** Token-aware proactive compaction budget. When estimated context tokens
   *  exceed limit * triggerRatio before a model turn, compact once. Leave
   *  undefined to disable proactive compaction. */
  readonly contextBudget?: ContextBudget;
}

/** A Coding Agent Session owns the store, plugins, listeners, and lifecycle.
 *  Each call to startLoop/startFollowUp creates a one-shot internal loop; the
 *  session itself is the long-lived controller. */
export interface CodingAgentSession {
  readonly sessionId: string;
  readonly status: "idle" | "running" | "completed" | "failed" | "stopped";
  startLoop(deps: LoopInputDeps): Promise<void>;
  startFollowUp(deps: LoopInputDeps): Promise<void>;
  steer(text: string): void;
  stop(): void;
  compact(): Promise<void>;
  onEvent(listener: AgentLoopListener): () => void;
}

export function createCodingAgentSession(opts: CodingAgentSessionOptions): CodingAgentSession {
  validatePlugins(opts.plugins);
  const listeners = new Set<AgentLoopListener>();
  const tools = collectTools(opts.plugins);
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  let status: "idle" | "running" | "completed" | "failed" | "stopped" = "idle";
  // Active-loop ownership is separate from terminal status: the loop is
  // "active" from startLoop until listeners settle in finally. This prevents
  // a concurrent startFollowUp from racing with agent_end listeners.
  let active = false;
  let controller: AbortController | null = null;
  const steerQueue: string[] = [];
  let acceptingSteer = false;

  async function emit(event: CodingAgentLoopEvent): Promise<void> {
    for (const l of listeners) {
      try {
        await l(event);
      } catch {
        /* listener error is logged but not fatal */
      }
    }
  }

  async function runLoop(deps: LoopInputDeps, mode: "normal" | "follow_up"): Promise<void> {
    if (active) throw new Error("Loop already active");
    active = true;
    status = "running";
    controller = new AbortController();
    steerQueue.length = 0;

    await emit({ type: "agent_start" });

    try {
      // Build and persist loop input: product history + one Meta + one Prompt.
      // The System Prompt snapshot comes from THIS run's input (AgentRunSnapshot),
      // not from loop construction.
      const input = buildLoopInput(deps, mode);
      const systemPrompt = input.systemPrompt;
      await opts.store.appendBatch(opts.sessionId, input.batch);

      // Read branch for model messages
      let messages = await readBranchMessages();

      let step = 0;
      let forceContinues = 0;
      let overflowCompacted = false;
      let thresholdCompacted = false;
      let naturalStop = false;

      while (step < opts.maxSteps && !naturalStop) {
        if (controller?.signal.aborted) break;
        step++;
        // Steer is accepted only when there's capacity for at least one more
        // safe-boundary turn after the current one.
        acceptingSteer = step < opts.maxSteps;

        // Drain steer queue at safe boundary
        if (steerQueue.length > 0) {
          const steers = steerQueue.splice(0);
          for (const text of steers) {
            await opts.store.appendBatch(opts.sessionId, {
              entries: [
                {
                  type: "message",
                  role: "user",
                  source: "steer",
                  message: { role: "user", text },
                  createdAt: Date.now(),
                },
              ],
            });
          }
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
              const result = p.hooks.beforeModel(transformed);
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
                return;
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
                });
                if (vetoed && forceContinues < opts.maxForceContinues) {
                  forceContinues++;
                  stopped = false;
                  break;
                }
              }
            }
            naturalStop = stopped;
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
              await emit({ type: "agent_end", status });
              controller = null;
              return;
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
            status = "failed";
            await emit({ type: "agent_end", status });
            controller = null;
            return;
          }
        }

        await emit({ type: "turn_end", turn: step });
        if (naturalStop) break;
      }

      if (controller?.signal.aborted) {
        status = "stopped";
        await emit({ type: "agent_end", status });
      } else if (!naturalStop && step >= opts.maxSteps && status === "running") {
        status = "failed";
        await emit({ type: "agent_end", status });
      } else if (status === "running") {
        status = "completed";
        await emit({ type: "agent_end", status });
      }
    } catch (err) {
      // Setup/persistence failure: the loop must settle to a terminal state
      // so listeners always receive agent_end and the loop is reusable.
      void err;
      status = controller?.signal.aborted ? "stopped" : "failed";
      await emit({ type: "agent_end", status });
    } finally {
      active = false;
      controller = null;
      steerQueue.length = 0;
      acceptingSteer = false;
    }
  }

  async function processModelTurn(messages: readonly Message[]): Promise<PendingToolCall[]> {
    let assistantText = "";
    const toolCallBuilders = new Map<string, { id: string; name: string; jsonParts: string[] }>();

    await emit({ type: "message_start" });
    const stream = retryStream(
      (signal) => opts.modelStream(messages, signal),
      {
        maxAttempts: opts.maxRetries ?? 3,
        baseDelayMs: 1000,
        onRetryStart: (attempt) => emit({ type: "retry_start", attempt }),
        onRetryEnd: () => emit({ type: "retry_end" }),
      },
      controller?.signal,
    );

    try {
      for await (const chunk of stream) {
        if (controller?.signal.aborted) break;
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
      await emit({ type: "tool_execution_start", toolName: call.name });
      const tool = toolMap.get(call.name);
      let result: unknown;
      let isError = false;
      let terminate = false;
      if (tool) {
        try {
          result = await tool.execute(call.input, controller?.signal);
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
      await emit({
        type: "tool_execution_end",
        toolName: call.name,
        result: (result ?? {}) as Readonly<Record<string, unknown>>,
      });
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
      await runLoop(deps, "normal");
    },

    async startFollowUp(deps) {
      await runLoop(deps, "follow_up");
    },
    steer(text) {
      if (status !== "running" || !acceptingSteer) {
        throw new Error("Steer is only accepted during a loop with remaining turn capacity");
      }
      steerQueue.push(text);
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
  };
}

function safeParseJson(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
