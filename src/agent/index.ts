// src/agent/index.ts
export { Agent } from './Agent';
export { ContextManager } from './context';
export { composeMiddlewares } from './middleware';
// TODO: Add agentic loop types and tool registry in subsequent tasks
export type {
  AgentEvent,
  AgentLoopConfig,
  AggregatedUsage,
  TextDeltaEvent,
  ToolCallStartEvent,
  ToolCallResultEvent,
  TurnCompleteEvent,
  AgentDoneEvent,
  AgentErrorEvent,
} from './loop-types';
export { DEFAULT_LOOP_CONFIG } from './loop-types';
export { ToolRegistry } from './tool-registry';
