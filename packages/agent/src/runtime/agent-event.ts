import type { ToolUseBlock } from "@my-agent-team/core";
import { MessageRevisionSchema } from "@my-agent-team/message";
import { z } from "zod";

// ─── Interrupt ────────────────────────────────────────────────

export interface Interrupt {
  pendingTool?: ToolUseBlock;
  reason: string;
  meta?: Record<string, unknown>;
}

// ─── AgentEvent codec — zod schema is the single source of truth ──

const interruptSchema = z.object({
  pendingTool: z
    .object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() })
    .optional(),
  reason: z.string(),
  meta: z.record(z.unknown()).optional(),
});

const agentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_start"), spanId: z.string() }),
  z.object({ type: z.literal("message"), payload: MessageRevisionSchema }),
  z.object({ type: z.literal("message_update"), payload: MessageRevisionSchema }),
  z.object({
    type: z.literal("llm_call"),
    payload: z.object({
      step: z.number(),
      model: z.string(),
      usage: z.object({
        input: z.number(),
        output: z.number(),
        cacheCreate: z.number().optional(),
        cacheRead: z.number().optional(),
      }),
      latencyMs: z.number(),
      ttftMs: z.number().optional(),
      stopReason: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("tool_execution_start"),
    payload: z.object({ id: z.string(), name: z.string(), step: z.number() }),
  }),
  z.object({
    type: z.literal("tool_call"),
    payload: z.object({
      step: z.number(),
      id: z.string(),
      name: z.string(),
      latencyMs: z.number(),
      isError: z.boolean(),
      args: z.unknown().optional(),
      result: z.object({ content: z.string(), isError: z.boolean().optional() }).optional(),
    }),
  }),
  z.object({ type: z.literal("interrupted"), payload: interruptSchema }),
  z.object({
    type: z.literal("todo_update"),
    spanId: z.string().optional(),
    payload: z.object({
      todos: z.array(
        z.object({
          step: z.string(),
          status: z.enum(["pending", "in_progress", "done", "cancelled"]),
        }),
      ),
    }),
  }),
  z.object({
    type: z.literal("pet_bark"),
    payload: z.object({
      mood: z.enum(["happy", "neutral", "frustrated", "excited"]),
      text: z.string(),
      level: z.number(),
      turn: z.number(),
    }),
  }),
  z.object({
    type: z.literal("recap_update"),
    payload: z.object({
      text: z.string(),
      turn: z.number(),
    }),
  }),
  z.object({
    type: z.literal("agent_end"),
    spanId: z.string().optional(),
    status: z.enum(["succeeded", "error", "interrupted"]),
    messages: z.array(z.unknown()).optional(),
    willRetry: z.boolean().optional(),
    errorMessage: z.string().optional(),
  }),
  // ── Session-level events (merged from harness AgentSessionEvent) ──
  z.object({
    type: z.literal("queue_update"),
    steering: z.string().array(),
    followUp: z.string().array(),
  }),
  z.object({
    type: z.literal("compaction_start"),
    reason: z.enum(["manual", "threshold", "overflow"]),
  }),
  z.object({
    type: z.literal("compaction_end"),
    reason: z.enum(["manual", "threshold", "overflow"]),
    result: z.unknown().optional(),
    aborted: z.boolean(),
    willRetry: z.boolean(),
    errorMessage: z.string().optional(),
  }),
  z.object({
    type: z.literal("auto_retry_start"),
    attempt: z.number(),
    maxAttempts: z.number(),
    delayMs: z.number(),
    errorMessage: z.string(),
  }),
  z.object({
    type: z.literal("auto_retry_end"),
    success: z.boolean(),
    attempt: z.number(),
    finalError: z.string().optional(),
  }),
]);

/** AgentEvent — the single message-streaming event type, derived from zod schema. */
export type AgentEvent = z.infer<typeof agentEventSchema>;

/** Parse an AgentEvent from wire/persistence, throwing on invalid shape. */
export function parseAgentEvent(raw: unknown): AgentEvent {
  return agentEventSchema.parse(raw) as AgentEvent;
}

/** Safe-parse an AgentEvent (returns success/error instead of throwing). */
export function safeParseAgentEvent(raw: unknown): z.SafeParseReturnType<unknown, AgentEvent> {
  return agentEventSchema.safeParse(raw) as z.SafeParseReturnType<unknown, AgentEvent>;
}
