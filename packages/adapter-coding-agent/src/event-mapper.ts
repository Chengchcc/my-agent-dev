import type { BackendEvent, BackendRunOutcome } from "@my-agent-team/agent-backend";

/** Map daemon transport event envelopes to Backend core events, namespacing
 *  Runtime-specific details under `backend.coding_agent.*`. Outcome mapping is
 *  the ONLY terminal authority. */

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
      // native_tool_started. The worker's resolved Product Tools carry
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
    case "agent_end":
      // The daemon emits agent_end ONLY for completed runs; map it onto the
      // core terminal vocabulary so surfaces can rely on `status: completed`
      // instead of parsing daemon-private event names.
      return { type: "status", status: "completed" };
    default:
      return {
        type: `backend.coding_agent.${event.type}`,
        payload: { eventId: event.id, ...event.data },
      };
  }
}

/** Map a transport outcome to the Backend terminal outcome. `suspended` is
 *  rejected because this backend declares pendingActionResponse=false. */
export function mapRunOutcome(outcome: {
  status: string;
  output?: unknown;
  error?: string;
  usage?: unknown;
}): BackendRunOutcome {
  if (outcome.status === "completed") {
    return {
      status: "completed",
      output: outcome.output as never,
      usage: outcome.usage as never,
    };
  }
  if (outcome.status === "aborted") {
    return { status: "aborted", error: outcome.error };
  }
  if (outcome.status === "timeout") {
    return { status: "timeout", error: outcome.error };
  }
  if (outcome.status === "suspended") {
    throw new Error("coding_agent backend does not support suspended outcomes");
  }
  return { status: "failed", error: outcome.error ?? "run failed" };
}
