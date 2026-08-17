import type { TodoItem } from "./todo.js";

/** Pi-style typed lifecycle events per runtime/oma.md. */
export type OmaLoopEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; status: "completed" | "failed" | "stopped" }
  | { type: "turn_start"; turn: number }
  | { type: "turn_end"; turn: number }
  | { type: "message_start" }
  | { type: "message_update"; text: string }
  | { type: "thinking_update"; text: string }
  | { type: "message_end" }
  | { type: "tool_execution_start"; toolName: string; kind?: "native" | "product"; callId: string }
  | {
      type: "tool_execution_end";
      toolName: string;
      kind?: "native" | "product";
      callId: string;
      result?: Readonly<Record<string, unknown>>;
    }
  | { type: "retry_start"; attempt: number }
  | { type: "retry_end" }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "queue_update" }
  | { type: "recap_update"; text: string; turn: number }
  | { type: "todo_update"; items: readonly TodoItem[] }
  | { type: "workflow_started"; workflowId: string; label: string; agentCount: number }
  | { type: "workflow_agent_started"; workflowId: string; agentId: string; label: string }
  | {
      type: "workflow_agent_completed";
      workflowId: string;
      agentId: string;
      label: string;
      ok: boolean;
      error?: string;
      usage?: unknown;
    }
  | {
      type: "workflow_completed";
      workflowId: string;
      ok: boolean;
      agentCount: number;
      totalTokens: number;
    };

export type AgentLoopListener = (event: OmaLoopEvent) => void | Promise<void>;
