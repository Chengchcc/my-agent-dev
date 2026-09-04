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
  | {
      type: "tool_execution_start";
      toolName: string;
      kind?: "native" | "product";
      callId: string;
      /** The tool's resolved input (model call args), for transcript display. */
      input?: Readonly<Record<string, unknown>>;
      /** Wall-clock timeout for this tool (ms, 0 = disabled). */
      timeoutMs?: number;
    }
  | {
      type: "tool_execution_end";
      toolName: string;
      kind?: "native" | "product";
      callId: string;
      result?: Readonly<Record<string, unknown>>;
    }
  | {
      /** Streaming partial output from a running tool (bash stdout). */
      type: "tool_output";
      toolName: string;
      callId: string;
      text: string;
    }
  | { type: "retry_start"; attempt: number }
  | { type: "retry_end" }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  /** Emitted when the loop drains queued steers at a safe boundary.
   * `drained` carries the injected user texts (pi's message_start(user) →
   * addMessageToChat): surfaces render the user message when the loop
   * actually takes it, not when it was submitted. */
  | { type: "queue_update"; drained?: readonly string[] }
  | {
      /** REAL runtime MCP mount result: the child actually connected and
       *  listed tools. Surfaces the manager-probe vs runtime distinction. */
      type: "mcp_mount_result";
      server: string;
      ok: boolean;
      toolsCount: number;
      error?: string;
    }
  | { type: "stream_rule_triggered"; rule: string }
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
    }
  | { type: "workflow_failed"; workflowId: string; error: string };

export type AgentLoopListener = (event: OmaLoopEvent) => void | Promise<void>;
