import type { AIMessageChunk } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { SessionStore } from "../persistence/session-store.js";
import { buildLoopInput } from "./loop-input.js";
import type { LoopInputDeps } from "./loop-input.js";
import type { Plugin, PluginTool } from "./plugin.js";
import { collectTools } from "./plugin.js";
import type { CodingAgentLoopEvent, AgentLoopListener } from "./agent-event.js";

export type { CodingAgentLoopEvent, AgentLoopListener };

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
}

export interface AgentLoop {
  readonly sessionId: string;
  readonly status: "idle" | "running" | "settled";
  startLoop(deps: LoopInputDeps): Promise<void>;
  steer(text: string): Promise<void>;
  stop(): void;
  onEvent(listener: AgentLoopListener): () => void;
}

export function createAgentLoop(opts: AgentLoopOptions): AgentLoop {
  const listeners = new Set<AgentLoopListener>();
  const tools = collectTools(opts.plugins);
  let status: "idle" | "running" | "settled" = "idle";
  let controller: AbortController | null = null;
  const steerQueue: string[] = [];

  async function emit(event: CodingAgentLoopEvent): Promise<void> {
    for (const l of listeners) {
      try {
        await l(event);
      } catch {
        /* log */
      }
    }
  }

  return {
    sessionId: opts.sessionId,
    get status() {
      return status;
    },

    async startLoop(deps: LoopInputDeps) {
      if (status !== "idle") throw new Error("Loop already active");
      status = "running";
      controller = new AbortController();

      await emit({ type: "agent_start" });

      // Build and append loop input
      const input = buildLoopInput(
        [],
        {
          runId: crypto.randomUUID(),
          model: { backendKind: "", modelId: "" },
          productTools: [],
          configRevision: 1,
        },
        deps,
        "normal",
      );
      await opts.store.appendBatch(opts.sessionId, input.batch);

      // Read initial branch for messages
      const entries = await opts.store.readBranch(opts.sessionId);
      const messages: Message[] = entries
        .filter((e) => e.type === "message")
        .map((e) => (e as { message: Message }).message);

      let step = 0;
      while (step < opts.maxSteps && !controller.signal.aborted) {
        step++;
        await emit({ type: "turn_start", turn: step });

        try {
          // Drain steer queue at safe boundary
          if (steerQueue.length > 0) {
            const texts = steerQueue.splice(0);
            for (const text of texts) {
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
              messages.push({ role: "user", text });
            }
            await emit({ type: "queue_update" });
          }

          // Stream model response
          let assistantText = "";
          const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

          for await (const chunk of opts.modelStream(messages, controller.signal)) {
            if (controller.signal.aborted) break;
            if (chunk.delta?.type === "text") {
              assistantText += chunk.delta.text;
              await emit({ type: "message_update", text: chunk.delta.text });
            }
            if (chunk.delta?.type === "tool_use") {
              toolCalls.push({ id: chunk.delta.id, name: chunk.delta.name, input: {} });
            }
          }

          if (controller.signal.aborted) break;

          // Persist assistant message
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
            messages.push({ role: "assistant", text: assistantText });
          }

          // Execute tools
          if (toolCalls.length > 0) {
            await emit({ type: "tool_execution_start" });
            for (const tc of toolCalls) {
              const tool = tools.find((t) => t.name === tc.name);
              if (tool) {
                try {
                  const result = await tool.execute(tc.input);
                  await opts.store.appendBatch(opts.sessionId, {
                    entries: [
                      {
                        type: "message",
                        role: "tool",
                        source: "tool_result",
                        message: { role: "tool", text: JSON.stringify(result) },
                        createdAt: Date.now(),
                      },
                    ],
                  });
                } catch (err) {
                  await opts.store.appendBatch(opts.sessionId, {
                    entries: [
                      {
                        type: "message",
                        role: "tool",
                        source: "tool_result",
                        message: {
                          role: "tool",
                          text: JSON.stringify({
                            error: err instanceof Error ? err.message : String(err),
                          }),
                        },
                        createdAt: Date.now(),
                      },
                    ],
                  });
                }
              }
            }
            await emit({ type: "tool_execution_end" });
            // Continue loop for next model turn with tool results
            const updated = await opts.store.readBranch(opts.sessionId);
            messages.length = 0;
            messages.push(
              ...updated
                .filter((e) => e.type === "message")
                .map((e) => (e as { message: Message }).message),
            );
            continue;
          }

          // Natural stop - let plugins veto
          await emit({ type: "turn_end", turn: step });
          break;
        } catch (err) {
          await emit({
            type: "turn_failed",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Settle
      await emit({ type: "agent_end" });
      controller = null;
      status = "settled";
    },

    async steer(text: string) {
      steerQueue.push(text);
      await emit({ type: "steer_received", text });
    },

    stop() {
      controller?.abort();
    },

    onEvent(listener: AgentLoopListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
