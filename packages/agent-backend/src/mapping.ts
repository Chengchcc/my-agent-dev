import type { BackendEvent, BackendRunOutcome } from "./index.js";

/** Map Coding Agent transport event envelopes to Backend core events,
 *  namespacing Runtime-specific details under `backend.coding_agent.*`.
 *  Outcome mapping is the ONLY terminal authority. Lives in the CONTRACT
 *  package so both sides of the stdio boundary map identically: the Coding
 *  Agent's in-process segment and the adapter's wire consumer. */

export interface TransportRunEvent {
  id: number;
  type: string;
  data: Readonly<Record<string, unknown>>;
}

export function mapRunEvent(event: TransportRunEvent): BackendEvent<"coding_agent"> {
  switch (event.type) {
    case "message_update": {
      const text = String(event.data.text ?? "");
      return { type: "text_delta", text };
    }
    case "thinking_update": {
      const text = String(event.data.text ?? "");
      return { type: "thinking_delta", text };
    }
    case "message_start":
    case "message_end":
    case "retry_start":
    case "retry_end":
    case "compaction_start":
    case "compaction_end":
    case "queue_update":
      // Runtime lifecycle: namespaced extension, never product state
      return {
        type: `backend.coding_agent.${event.type}`,
        payload: { eventId: event.id, ...event.data },
      };
    case "tool_execution_start": {
      const toolName = String(event.data.toolName ?? "unknown");
      const callId = String(event.data.callId ?? `call-${event.id}`);
      // Product Tools map to product_tool_started; native tools to
      // native_tool_started. The run runtime's resolved Product Tools carry
      // kind="product", surfaced on the runtime event.
      if (event.data.kind === "product") {
        return { type: "product_tool_started", toolName, callId };
      }
      return { type: "native_tool_started", toolName, callId };
    }
    case "tool_execution_end": {
      const toolName = String(event.data.toolName ?? "unknown");
      const callId = String(event.data.callId ?? `call-${event.id}`);
      const result = event.data.result as Readonly<Record<string, unknown>> | undefined;
      if (event.data.kind === "product") {
        return { type: "product_tool_completed", toolName, callId, result };
      }
      return { type: "native_tool_completed", toolName, callId, result };
    }
    case "agent_start":
    case "turn_start":
    case "turn_end":
      return { type: "status", status: event.type };
    case "agent_end": {
      // agent_end carries the ACTUAL terminal status from the loop
      // (completed | failed | stopped): map it onto the core terminal
      // vocabulary - completed stays completed, failed stays failed, stopped
      // becomes aborted. Never a bare "agent_end" status.
      const status = String(event.data.status ?? "completed");
      if (status === "failed") return { type: "status", status: "failed" };
      if (status === "stopped") return { type: "status", status: "aborted" };
      return { type: "status", status: "completed" };
    }
    default:
      return {
        type: `backend.coding_agent.${event.type}`,
        payload: { eventId: event.id, ...event.data },
      };
  }
}

/** Map a transport outcome to the Backend terminal outcome. The Coding Agent
 *  only produces completed/failed/aborted (timeout is reserved for future
 *  backends). */
export function mapRunOutcome(outcome: {
  status: string;
  messages?: unknown;
  error?: string;
  usage?: unknown;
  title?: string;
}): BackendRunOutcome {
  if (outcome.status === "completed") {
    return {
      status: "completed",
      messages: outcome.messages as never,
      usage: outcome.usage as never,
      ...(outcome.title ? { title: outcome.title } : {}),
    };
  }
  if (outcome.status === "aborted") {
    return { status: "aborted", error: outcome.error };
  }
  if (outcome.status === "timeout") {
    return { status: "timeout", error: outcome.error };
  }
  return { status: "failed", error: outcome.error ?? "run failed" };
}
