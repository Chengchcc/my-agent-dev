import type { ContentBlock, ToolResultBlock, ToolUseBlock } from "@my-agent-team/core";

/** 执行事件日志 -- observability 职责。 */
export type CheckpointEvent =
  | { type: "user_input"; content: string; ts: number }
  | { type: "model_start"; messageCount: number; ts: number }
  | {
      type: "model_end";
      blocks: ContentBlock[];
      usage?: { input: number; output: number };
      /** Model identifier (e.g. "claude-sonnet-4-6"). */
      model: string;
      /** Step number within the run loop. */
      step: number;
      /** Total LLM call latency in ms (from stream start to end). */
      latencyMs: number;
      /** Time-to-first-token in ms (undefined if not measured). */
      ttftMs?: number;
      /** Model stop reason (e.g. "end_turn", "tool_use", "max_tokens"). */
      stopReason?: string;
      ts: number;
    }
  | { type: "tool_start"; call: ToolUseBlock; ts: number }
  | {
      type: "tool_end";
      result: ToolResultBlock;
      durationMs: number;
      /** Step number within the run loop. */
      step: number;
      /** Tool name (e.g. "bash", "read"). */
      name: string;
      /** Whether the tool execution resulted in an error. */
      isError: boolean;
      ts: number;
    }
  | { type: "interrupt"; pendingTool: ToolUseBlock; reason: string; ts: number }
  | { type: "resume"; ts: number }
  | { type: "run_end"; reason: "complete" | "aborted" | "maxSteps"; ts: number }
  | { type: "force_continue"; reason: string; attempt: number; ts: number };

/** Row shape returned by readEvents - includes spanId and ts from the storage layer. */
export type CheckpointEventRow = CheckpointEvent & { spanId: string | null; ts: number };

export interface EventLog {
  /**
   * Append an execution fact event. spanId identifies the current prompt loop
   * (runId in backend terms); pass undefined for events outside a span context.
   */
  appendEvent(sessionId: string, spanId: string | undefined, event: CheckpointEvent): Promise<void>;
  /** Read execution fact events. Pass { spanId } to filter to a single span. */
  readEvents(sessionId: string, opts?: { spanId?: string }): AsyncIterable<CheckpointEventRow>;
}
