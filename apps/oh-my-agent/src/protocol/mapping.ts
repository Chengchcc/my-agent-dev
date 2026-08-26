import type { BackendEvent, BackendRunOutcome } from "@chengchenccc/agent-contract";

/** Map Oma transport event envelopes to Backend core events,
 *  namespacing Runtime-specific details under `backend.oma.*`.
 *  Outcome mapping is the ONLY terminal authority. Lives in the CONTRACT
 *  package so both sides of the stdio boundary map identically: the Coding
 *  Agent's in-process segment and the adapter's wire consumer. */

export interface TransportRunEvent {
  id: number;
  type: string;
  data: Readonly<Record<string, unknown>>;
}

export function mapRunEvent(event: TransportRunEvent): BackendEvent<"oma"> {
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
        type: `backend.oma.${event.type}`,
        payload: { eventId: event.id, ...event.data },
      };
    case "tool_execution_start": {
      const toolName = String(event.data.toolName ?? "unknown");
      const callId = String(event.data.callId ?? `call-${event.id}`);
      return { type: "native_tool_started", toolName, callId };
    }
    case "tool_execution_end": {
      const toolName = String(event.data.toolName ?? "unknown");
      const callId = String(event.data.callId ?? `call-${event.id}`);
      const result = event.data.result as Readonly<Record<string, unknown>> | undefined;
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
    case "workflow_started":
      return {
        type: "workflow_started",
        workflowId: String(event.data.workflowId ?? ""),
        label: String(event.data.label ?? ""),
        agentCount: Number(event.data.agentCount ?? 0),
      };
    case "workflow_agent_started":
      return {
        type: "workflow_agent_started",
        workflowId: String(event.data.workflowId ?? ""),
        agentId: String(event.data.agentId ?? ""),
        label: String(event.data.label ?? ""),
      };
    case "workflow_agent_completed": {
      const usage = event.data.usage as Readonly<Record<string, unknown>> | undefined;
      return {
        type: "workflow_agent_completed",
        workflowId: String(event.data.workflowId ?? ""),
        agentId: String(event.data.agentId ?? ""),
        label: String(event.data.label ?? ""),
        ok: event.data.ok === true,
        ...(typeof event.data.error === "string" ? { error: event.data.error } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    case "workflow_completed":
      return {
        type: "workflow_completed",
        workflowId: String(event.data.workflowId ?? ""),
        ok: event.data.ok === true,
        agentCount: Number(event.data.agentCount ?? 0),
        totalTokens: Number(event.data.totalTokens ?? 0),
      };
    default:
      return {
        type: `backend.oma.${event.type}`,
        payload: { eventId: event.id, ...event.data },
      };
  }
}

/** Map a transport outcome to the Backend terminal outcome. The Oma
 *  only produces completed/failed/aborted (timeout is reserved for future
 *  backends). */
export function mapRunOutcome(outcome: {
  status: string;
  messages?: unknown;
  error?: string;
  usage?: unknown;
  title?: string;
  cliSessionRef?: string;
  workflow?: unknown;
}): BackendRunOutcome {
  // The child's session reference (ADR 0003) survives every terminal status:
  // the product round-trips it into branch.cliSessionRef for the next run.
  const ref = outcome.cliSessionRef ? { cliSessionRef: outcome.cliSessionRef } : {};
  if (outcome.status === "completed") {
    return {
      status: "completed",
      messages: outcome.messages as never,
      usage: outcome.usage as never,
      ...(outcome.title ? { title: outcome.title } : {}),
      ...(outcome.workflow !== undefined ? { workflow: outcome.workflow as never } : {}),
      ...ref,
    };
  }
  if (outcome.status === "aborted") {
    return { status: "aborted", error: outcome.error, ...ref };
  }
  if (outcome.status === "timeout") {
    return { status: "timeout", error: outcome.error, ...ref };
  }
  return { status: "failed", error: outcome.error ?? "run failed", ...ref };
}
