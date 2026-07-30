import type { ModelRuntime } from "@my-agent-team/ai";
import type { Message } from "@my-agent-team/message";
import type { SessionStore } from "../persistence/session-store.js";
import type { AgentLoopListener, CodingAgentLoopEvent } from "./agent-event.js";
import type { LoopInputDeps } from "./loop-input.js";
import { buildLoopInput } from "./loop-input.js";
import type { Plugin, PluginTool } from "./plugin.js";
import { collectTools } from "./plugin.js";

export type { AgentLoopListener, CodingAgentLoopEvent };

export interface AgentLoopOptions {
  readonly sessionId: string;
  readonly store: SessionStore;
  readonly modelRuntime: ModelRuntime;
  readonly plugins: readonly Plugin[];
  readonly systemPrompt: string;
  readonly maxSteps: number;
  readonly maxForceContinues: number;
  readonly providerId: string;
  readonly modelId: string;
}

export interface AgentLoop {
  readonly sessionId: string;
  readonly status: "idle" | "running" | "settled";
  startLoop(input: LoopInputDeps): Promise<void>;
  steer(text: string): Promise<void>;
  stop(): Promise<void>;
  compact(): Promise<void>;
  onEvent(listener: AgentLoopListener): () => void;
}

export function createAgentLoop(opts: AgentLoopOptions): AgentLoop {
  const listeners = new Set<AgentLoopListener>();
  let status: "idle" | "running" | "settled" = "idle";
  let stopped = false;
  const tools = collectTools(opts.plugins);

  async function runLoop(
    input: LoopInputDeps,
    history: readonly { productEntryId: string; message: Message }[],
    mode: "normal" | "steer" | "follow_up",
  ): Promise<void> {
    if (status !== "idle") throw new Error("Agent Loop already active");
    status = "running";
    stopped = false;

    const snapshot = {
      runId: crypto.randomUUID(),
      model: { backendKind: opts.providerId, modelId: opts.modelId },
      productTools: [],
      configRevision: 1,
    };
    const loopInput = buildLoopInput(history, snapshot, input, mode);
    const messages = await appendAndShape(loopInput, opts, tools, listeners);

    let step = 0;
    while (step < opts.maxSteps && !stopped) {
      step++;
      emit("turn_start", { turn: step });
      try {
        const stream = opts.modelRuntime.stream(opts.providerId, opts.modelId, messages);
        let assistantText = "";
        for await (const chunk of stream) {
          if (stopped) break;
          if (chunk.delta?.type === "text") {
            assistantText += chunk.delta.text;
            emit("message_update", { text: chunk.delta.text });
          }
          if (chunk.delta?.type === "tool_use" || chunk.stopReason === "tool_use") {
            emit("tool_execution_start", {});
          }
        }
        if (assistantText) {
          messages.push({ role: "assistant", text: assistantText });
          await opts.store.appendBatch(opts.sessionId, {
            entries: [
              {
                type: "message",
                productEntryId: null,
                role: "assistant",
                source: "assistant",
                message: { role: "assistant", text: assistantText },
                createdAt: Date.now(),
              },
            ],
          });
        }
        // Natural stop
        if (!stopped && step < opts.maxSteps) {
          emit("agent_end", { status: "completed" });
          break;
        }
      } catch (err) {
        emit("turn_failed", { error: err instanceof Error ? err.message : String(err) });
      }
      emit("turn_end", { turn: step });
    }

    // Settle: await listeners
    await settle(listeners);
    status = "settled";
  }

  return {
    sessionId: opts.sessionId,
    get status() {
      return status;
    },
    async startLoop(input: LoopInputDeps) {
      await runLoop(input, [], "normal");
    },
    async steer(text: string) {
      if (status !== "running") throw new Error("No active loop to steer");
      const entries = await opts.store.readBranch(opts.sessionId);
      const messages = entries.map((e) =>
        e.type === "message" ? e.message : { role: "user" as const, text: "" },
      );
      messages.push({ role: "user", text });
      emit("steer_received", { text });
    },
    async stop() {
      stopped = true;
    },
    async compact() {
      emit("compaction_start", {});
    },
    onEvent(listener: AgentLoopListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function emit(_event: string, _payload: Record<string, unknown>): void {
  /* stub */
}

async function appendAndShape(
  input: ReturnType<typeof buildLoopInput>,
  opts: AgentLoopOptions,
  _tools: PluginTool[],
  _listeners: Set<AgentLoopListener>,
): Promise<Message[]> {
  await opts.store.appendBatch(opts.sessionId, input.batch);
  const entries = await opts.store.readBranch(opts.sessionId);
  return entries.map((e) =>
    e.type === "message" ? e.message : { role: "user" as const, text: "" },
  );
}

async function settle(listeners: Set<AgentLoopListener>): Promise<void> {
  for (const l of listeners) {
    try {
      await l({ type: "agent_end" });
    } catch {
      /* log */
    }
  }
}
