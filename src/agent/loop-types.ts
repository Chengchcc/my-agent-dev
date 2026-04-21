// src/agent/loop-types.ts
import type { ToolCall } from '../types';

/**
 * Base interface for all agent events
 */
export interface AgentEventBase {
  type: string;
  turnIndex: number;
}

/**
 * Text delta event - streamed incremental content from the model
 */
export interface TextDeltaEvent extends AgentEventBase {
  type: 'text_delta';
  delta: string;
}

/**
 * Tool call started - yielded before execution starts
 * Allows UI to show a loading spinner immediately
 */
export interface ToolCallStartEvent extends AgentEventBase {
  type: 'tool_call_start';
  toolCall: ToolCall;
}

/**
 * Tool call completed - yielded after execution finishes
 * Contains the full result (or error)
 */
export interface ToolCallResultEvent extends AgentEventBase {
  type: 'tool_call_result';
  toolCall: ToolCall;
  result: unknown;
  error?: Error;
}

/**
 * Turn complete - a single LLM invocation + tool execution (if any) has finished
 */
export interface TurnCompleteEvent extends AgentEventBase {
  type: 'turn_complete';
  hasToolCalls: boolean;
}

/**
 * Agent done - full execution completed
 */
export interface AgentDoneEvent extends AgentEventBase {
  type: 'agent_done';
  totalTurns: number;
  reason: 'completed' | 'max_turns_reached' | 'error';
  error?: Error;
}

/**
 * Agent error - something went wrong during execution
 */
export interface AgentErrorEvent extends AgentEventBase {
  type: 'agent_error';
  error: Error;
}

/**
 * Union of all possible agent events
 */
export type AgentEvent =
  | TextDeltaEvent
  | ToolCallStartEvent
  | ToolCallResultEvent
  | TurnCompleteEvent
  | AgentDoneEvent
  | AgentErrorEvent;

/**
 * Strategy for handling tool errors
 * - 'continue': Add the error as a tool message to context and continue the loop
 * - 'halt': Stop execution immediately with an error
 */
export type ToolErrorStrategy = 'continue' | 'halt';

/**
 * Agent loop configuration - limits and behavior options
 */
export interface AgentLoopConfig {
  /** Maximum number of full turns (LLM → tools → LLM) before stopping */
  maxTurns: number;
  /** Total timeout for the entire agent execution in milliseconds */
  timeoutMs: number;
  /** Timeout for individual tool execution in milliseconds */
  toolTimeoutMs: number;
  /** Maximum characters in a single tool output before truncation */
  maxToolOutputChars: number;
  /** Allow parallel execution of multiple tool calls in the same turn */
  parallelToolExecution: boolean;
  /** Yield tool events as they complete (true) or wait for all and yield all at once (false) */
  yieldEventsAsToolsComplete: boolean;
  /** What to do when a tool execution throws an error */
  toolErrorStrategy: ToolErrorStrategy;
}

/**
 * Default agent loop configuration - reasonable safe defaults
 */
export const DEFAULT_LOOP_CONFIG: AgentLoopConfig = {
  maxTurns: 25,
  timeoutMs: 10 * 60 * 1000, // 10 minutes
  toolTimeoutMs: 2 * 60 * 1000, // 2 minutes
  maxToolOutputChars: 100 * 1024, // 100KB
  parallelToolExecution: true,
  yieldEventsAsToolsComplete: true,
  toolErrorStrategy: 'continue',
};

/**
 * Aggregated token usage across all turns
 */
export interface AggregatedUsage {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
}
