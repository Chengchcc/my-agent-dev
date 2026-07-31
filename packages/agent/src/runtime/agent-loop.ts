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

export interface AgentLoopOptions {
  readonly sessionId: string;
  readonly store: SessionStore;
  readonly plugins: readonly Plugin[];
  readonly maxSteps: number;
  readonly maxForceContinues: number;
  readonly modelStream: (
    messages: readonly Message[],
    signal?: AbortSignal,
  ) => AsyncIterable<AIMessageChunk>;
  readonly maxRetries?: number;
  /** Proactive compaction threshold: when the number of message entries on the
   *  active branch exceeds this value before a model turn, compact once. Leave
   *  undefined to disable proactive (threshold) compaction. */
  readonly compactionThreshold?: number;
}

export interface AgentLoop {
  readonly sessionId: string;
  readonly status: "idle" | "running" | "completed" | "failed" | "stopped";
  startLoop(deps: LoopInputDeps): Promise<void>;
  startFollowUp(deps: LoopInputDeps): Promise<void>;
  steer(text: string): void;
  stop(): void;
  compact(): Promise<void>;
  onEvent(listener: AgentLoopListener): () => void;
}

export function createAgentLoop(opts: AgentLoopOptions): AgentLoop {
  validatePlugins(opts.plugins);
  const listeners = new Set<AgentLoopListener>();
  const tools = collectTools(opts.plugins);
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  let status: "idle" | "running" | "completed" | "failed" | "stopped" = "idle";
  let controller: AbortController | null = null;
  const steerQueue: string[] = [];

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
    if (status === "running") throw new Error("Loop already active");
    status = "running";
    controller = new AbortController();

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
        await emit({ type: "turn_start", turn: step });

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
          if (opts.compactionThreshold !== undefined && !thresholdCompacted) {
            const branch = await opts.store.readBranch(opts.sessionId);
            const msgCount = branch.filter((e) => e.type === "message").length;
            if (msgCount > opts.compactionThreshold) {
              thresholdCompacted = true; // at most one proactive compaction per loop
              await emit({ type: "compaction_start" });
              await compactSession(opts.store, opts.sessionId, async (texts) => {
                return `[Compacted ${texts.length} earlier messages (threshold)]`;
              });
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
              if (toolResults.some((r) => r.terminate)) {
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
              await compactSession(opts.store, opts.sessionId, async (texts) => {
                return `[Compacted ${texts.length} earlier messages due to context overflow]`;
              });
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
      // Surface failure through agent_end status only; raw error text never
      // enters events or the tree (credential-safe).
      void err;
      status = "failed";
      await emit({ type: "agent_end", status });
    } finally {
      controller = null;
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
    await emit({ type: "message_end" });

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
      steerQueue.push(text);
    },

    stop() {
      controller?.abort();
    },

    async compact() {
      await emit({ type: "compaction_start" });
      // Manual compaction shares the one compaction implementation with
      // threshold/overflow triggers.
      await compactSession(opts.store, opts.sessionId, async (texts) => {
        return `[Compacted ${texts.length} earlier messages]`;
      });
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
