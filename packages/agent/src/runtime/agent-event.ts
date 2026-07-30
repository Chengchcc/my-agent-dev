export type CodingAgentLoopEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; status?: string }
  | { type: "turn_start"; turn: number }
  | { type: "turn_end"; turn: number }
  | { type: "turn_failed"; error: string }
  | { type: "message_start" }
  | { type: "message_update"; text: string }
  | { type: "message_end" }
  | { type: "tool_execution_start"; toolName?: string }
  | { type: "tool_execution_end"; toolName?: string; result?: Readonly<Record<string, unknown>> }
  | { type: "retry_start"; attempt: number }
  | { type: "retry_end" }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "steer_received"; text: string }
  | { type: "queue_update" };

export type AgentLoopListener = (event: CodingAgentLoopEvent) => void | Promise<void>;
