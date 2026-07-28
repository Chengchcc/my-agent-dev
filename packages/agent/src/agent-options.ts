import type { ChatModel, Tool } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { AgentEvent, AgentEventListener } from "./agent-events.js";
import type { AgentHooks } from "./agent-hooks.js";
import type { ContextPipeline } from "./index.js";
import type { EventLog } from "./persistence/event-log.js";
import type { InterruptStore } from "./persistence/interrupt-store.js";
import type { MessageStore } from "./persistence/message-store.js";
import type { Session } from "./persistence/session.js";
import type { RunState } from "./run-state.js";
import type { Logger } from "./runtime/logger.js";
import type { Plugin } from "./runtime/plugin.js";
import type { RunSpan } from "./runtime/trace.js";

export type AgentState =
  | "idle"
  | "running"
  | "compacting"
  | "retrying"
  | "waiting"
  | "done"
  | "error";

export interface AgentConfig {
  model: ChatModel;
  tools?: Tool[];
  plugins?: Plugin[];
  contextManager?: ContextPipeline;
  metaContext?: (ctx: {
    context: RunState;
    sessionId: string;
    threadMessages: readonly Message[];
  }) => string | undefined;
  systemPrompt?: string;
  sessionId?: string;
  messageStore?: MessageStore;
  eventLog?: EventLog;
  interruptStore?: InterruptStore;
  session?: Session;
  logger?: Logger;
  hooks?: AgentHooks;
  maxSteps?: number;
  retry?: { maxAttempts: number; backoffMs: number; maxBackoffMs?: number };
  compaction?: { autoCompact?: boolean; keepRecent?: number };
  startSpan?: (spanId: string, sessionId: string, opts?: unknown) => RunSpan | Promise<RunSpan>;
}

export type { AgentEvent, AgentEventListener };
