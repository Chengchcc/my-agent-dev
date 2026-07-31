import { ProviderError } from "@my-agent-team/ai";
import type { AIMessageChunk } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { SessionStore } from "../persistence/session-store.js";
import type { AgentLoopListener, CodingAgentLoopEvent } from "./agent-event.js";
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
  readonly systemPrompt: string;
  readonly maxSteps: number;
  readonly maxForceContinues: number;
  readonly modelStream: (
    messages: readonly Message[],
    signal?: AbortSignal,
  ) => AsyncIterable<AIMessageChunk>;
  readonly maxRetries?: number;
}

export interface AgentLoop {
  readonly sessionId: string;
  readonly status: "idle" | "running" | "completed" | "failed";
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
  let status: "idle" | "running" | "completed" | "failed" = "idle";
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
      // Build and persist loop input
      const input = buildLoopInput(
        [],
        {
          runId: crypto.randomUUID(),
          model: { backendKind: "", modelId: "" },
          productTools: [],
          configRevision: 1,
        } as never,
        deps,
        mode,
      );
      await opts.store.appendBatch(opts.sessionId, input.batch);

      // Read branch for model messages
      let messages = await readBranchMessages();

      let step = 0;
      let forceContinues = 0;
      let overflowCompacted = false;

      while (step < opts.maxSteps) {
        if (controller.signal.aborted) break;
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
          const modelMessages = opts.systemPrompt
            ? [{ role: "system", text: opts.systemPrompt } as Message, ...transformed]
            : transformed;
          const toolCalls = await processModelTurn(modelMessages);
          if (toolCalls.length > 0) {
            // Tool calls: execute and continue
            const toolResults = await executeTools(toolCalls);

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
                        },
                      ],
                    },
                    createdAt: Date.now(),
                  },
                ],
              });
            }

            messages = await readBranchMessages();
            await emit({ type: "turn_end", turn: step });
            continue;
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

          await emit({ type: "turn_end", turn: step });
          if (stopped) break;
        } catch (err) {
          // Overflow: one-shot compaction recovery
          if (err instanceof ProviderError && err.kind === "overflow" && !overflowCompacted) {
            overflowCompacted = true;
            await emit({ type: "compaction_start" });
            // Trigger compaction
            const entries = await opts.store.readBranch(opts.sessionId);
            const msgEntries = entries.filter((e) => e.type === "message");
            if (msgEntries.length > 4) {
              await opts.store.appendBatch(opts.sessionId, {
                entries: [
                  {
                    type: "compaction",
                    summary: `[Compacted ${msgEntries.length - 4} earlier messages due to context overflow]`,
                    coversEntryIds: msgEntries.slice(0, -4).map((e) => e.entryId),
                    createdAt: Date.now(),
                  },
                ],
              });
            }
            await emit({ type: "compaction_end" });
            continue; // retry with compacted context
          }

          const isFatal = !(err instanceof ProviderError) || !err.retryable;
          await emit({
            type: "turn_failed",
            error: err instanceof Error ? err.message : String(err),
          });
          if (isFatal) {
            status = "failed";
            await emit({ type: "agent_end" });
            controller = null;
            return;
          }
          // Retryable: retryStream handles backoff internally
        }
      }

      if (step >= opts.maxSteps && status === "running") {
        status = "failed";
        await emit({ type: "agent_end" });
      } else if (status === "running") {
        status = "completed";
        await emit({ type: "agent_end" });
      }
    } catch (err) {
      status = "failed";
      await emit({ type: "turn_failed", error: err instanceof Error ? err.message : String(err) });
      await emit({ type: "agent_end" });
    } finally {
      controller = null;
      if (status === "running") status = "completed";
    }
  }

  async function processModelTurn(messages: readonly Message[]): Promise<PendingToolCall[]> {
    let assistantText = "";
    const toolCallBuilders = new Map<string, { id: string; name: string; jsonParts: string[] }>();

    const stream = retryStream(
      (signal) => opts.modelStream(messages, signal),
      { maxAttempts: opts.maxRetries ?? 3, baseDelayMs: 1000 },
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
  ): Promise<Array<{ id: string; result: unknown }>> {
    const results: Array<{ id: string; result: unknown }> = [];
    for (const call of calls) {
      await emit({ type: "tool_execution_start" });
      const tool = toolMap.get(call.name);
      let result: unknown;
      if (tool) {
        try {
          result = await tool.execute(call.input);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
      } else {
        result = { error: `Unknown tool: ${call.name}` };
      }
      results.push({ id: call.id, result });
      await emit({ type: "tool_execution_end" });
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
      // Simple truncation: remove oldest messages past a threshold
      const entries = await opts.store.readBranch(opts.sessionId);
      const msgEntries = entries.filter((e) => e.type === "message");
      if (msgEntries.length > 8) {
        const summary = `[Compacted ${msgEntries.length - 4} earlier messages]`;
        await opts.store.appendBatch(opts.sessionId, {
          entries: [
            {
              type: "compaction",
              summary,
              coversEntryIds: msgEntries.slice(0, -4).map((e) => e.entryId),
              createdAt: Date.now(),
            },
          ],
        });
      }
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
