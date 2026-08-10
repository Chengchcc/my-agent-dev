import { LedgerEntry } from "@my-agent-team/conversation";
import type { z } from "zod";

// ── SSE event maps (event name → zod schema) ──

export const conversationEvents = {
  message: LedgerEntry,
  "member.joined": LedgerEntry,
  "member.left": LedgerEntry,
  todo: LedgerEntry,
  undo: LedgerEntry,
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
