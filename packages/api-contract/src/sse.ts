import { LedgerEntry } from "@chengchenccc/conversation";
import { z } from "zod";

// ── SSE event maps (event name → zod schema) ──

export const conversationEvents = {
  message: LedgerEntry,
  "member.joined": LedgerEntry,
  "member.left": LedgerEntry,
  todo: LedgerEntry,
  undo: LedgerEntry,
} as const satisfies SSEEventMap;

/** Agent-run live update stream (`/agent-runs/:runId/events`). Payloads are
 *  the BackendEvent objects the execution service broadcasts — core events
 *  carry fields at top level, oma extensions carry `{ payload }`. Schemas
 *  are intentionally loose on opaque payloads (todo items, workflow usage). */
export const runEvents = {
  status: z.object({
    type: z.literal("status"),
    status: z.string(),
    error: z.string().optional(),
  }),
  text_delta: z.object({ type: z.literal("text_delta"), text: z.string() }),
  thinking_delta: z.object({ type: z.literal("thinking_delta"), text: z.string() }),
  native_tool_started: z.object({
    type: z.literal("native_tool_started"),
    toolName: z.string().optional(),
    callId: z.string().optional(),
  }),
  native_tool_completed: z.object({
    type: z.literal("native_tool_completed"),
    toolName: z.string().optional(),
    callId: z.string().optional(),
    result: z.unknown().optional(),
  }),
  product_tool_started: z.object({
    type: z.literal("product_tool_started"),
    toolName: z.string().optional(),
    callId: z.string().optional(),
  }),
  product_tool_completed: z.object({
    type: z.literal("product_tool_completed"),
    toolName: z.string().optional(),
    callId: z.string().optional(),
    result: z.unknown().optional(),
  }),
  "backend.oma.todo_update": z.object({
    type: z.literal("backend.oma.todo_update"),
    payload: z.object({ items: z.array(z.unknown()).optional() }).optional(),
  }),
  workflow_started: z.object({
    type: z.literal("workflow_started"),
    workflowId: z.string().optional(),
    label: z.string().optional(),
    agentCount: z.number().optional(),
  }),
  workflow_agent_started: z.object({
    type: z.literal("workflow_agent_started"),
    workflowId: z.string().optional(),
    agentId: z.string().optional(),
    label: z.string().optional(),
  }),
  workflow_agent_completed: z.object({
    type: z.literal("workflow_agent_completed"),
    workflowId: z.string().optional(),
    agentId: z.string().optional(),
    label: z.string().optional(),
    ok: z.boolean().optional(),
    error: z.string().optional(),
    usage: z.unknown().optional(),
  }),
  workflow_completed: z.object({
    type: z.literal("workflow_completed"),
    workflowId: z.string().optional(),
    ok: z.boolean().optional(),
    agentCount: z.number().optional(),
    totalTokens: z.number().optional(),
  }),
  workflow_failed: z.object({
    type: z.literal("workflow_failed"),
    workflowId: z.string().optional(),
    error: z.string().optional(),
  }),
} as const satisfies SSEEventMap;

// ── SSE endpoint registry (path template + event map, single source) ──

/**
 * Registry of all SSE endpoints — binds path template to its event map.
 * Backend: matches for Elysia route mounting.
 * Frontend: `openSSE("conversationEvents", { id })` → typedSource with correct map.
 */
export const sseEndpoints = {
  conversationEvents: {
    path: (p: { id: string }) => `/conversations/${p.id}/events`,
    events: conversationEvents,
  },
  agentRunEvents: {
    path: (p: { runId: string }) => `/agent-runs/${p.runId}/events`,
    events: runEvents,
  },
} as const;

// ── SSE encoder (backend send side — validate payload before wire) ──

/**
 * Create an SSE encoder bound to an event map. The returned `encode` function
 * validates `data` against the schema for `event` before formatting as an
 * `{ id, event, data }` object suitable for `sseResponse()`.
 */
export function createSseEncoder<M extends SSEEventMap>(_map: M) {
  return function encode<K extends keyof M & string>(
    event: K,
    data: unknown,
    id: string,
  ): { id: string; event: string; data: z.infer<M[K]> } {
    const schema = _map[event] as z.ZodType;
    const validated = schema.parse(data) as z.infer<M[K]>;
    return { id, event, data: validated };
  };
}

// ── Types ──

export type SSEEventMap = Record<string, z.ZodType<unknown>>;

export interface SSEEndpoint<M extends SSEEventMap> {
  path: (...args: unknown[]) => string;
  events: M;
}

export type SSEEndpoints = Record<string, SSEEndpoint<SSEEventMap>>;
