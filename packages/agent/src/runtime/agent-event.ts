/** Pi-style typed lifecycle events per runtime/coding-agent.md. */
export type CodingAgentLoopEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; status: "completed" | "failed" | "stopped" }
  | { type: "turn_start"; turn: number }
  | { type: "turn_end"; turn: number }
  | { type: "message_start" }
  | { type: "message_update"; text: string }
  | { type: "message_end" }
  | { type: "tool_execution_start"; toolName: string }
  | { type: "tool_execution_end"; toolName: string; result?: Readonly<Record<string, unknown>> }
  | { type: "retry_start"; attempt: number }
  | { type: "retry_end" }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "queue_update" };

export type AgentLoopListener = (event: CodingAgentLoopEvent) => void | Promise<void>;
