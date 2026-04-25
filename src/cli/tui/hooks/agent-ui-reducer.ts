import type { Message } from '../../../types';
import type { SubAgentStartEvent, SubAgentDoneEvent, ToolCallStartEvent } from '../../../agent/loop-types';
import type { UITodoItem } from '../types';

export type AgentUIState = {
  streaming: boolean;
  messages: Message[];
  /** Current streaming content being generated (separate from messages for performance) */
  streamingContent: string | null;
  /** ID of the current streaming message */
  streamingMessageId: string | null;
  todos: UITodoItem[];
  currentTools: ToolCallStartEvent[];
  runningSubAgents: Map<string, SubAgentStartEvent>;
  completedSubAgents: Map<string, { summary: string; totalTurns: number; durationMs: number; isError: boolean }>;
  focusedToolId: string | null;
  expandedTools: Set<string>;
  toolResults: Map<string, { durationMs: number; isError: boolean }>;
  /** Total accumulated token usage */
  totalUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Start time of current streaming turn for elapsed display */
  streamingStartTime: number | null;
};

export type AgentUIAction =
  | { type: 'SUBMIT_START' }
  | { type: 'TEXT_DELTA_BATCH'; streamingMessageId: string; content: string }
  | { type: 'TOOL_START'; runningTools: Map<string, ToolCallStartEvent> }
  | { type: 'TOOL_RESULT'; runningTools: Map<string, ToolCallStartEvent>; toolId: string; result: { durationMs: number; isError: boolean }; messages: Message[]; todos: UITodoItem[] }
  | { type: 'LOOP_COMPLETE'; messages: Message[]; todos: UITodoItem[]; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { type: 'AGENT_ERROR'; errorMessage: Message }
  | { type: 'SUB_AGENT_START'; event: SubAgentStartEvent }
  | { type: 'SUB_AGENT_DONE'; event: SubAgentDoneEvent }
  | { type: 'FOCUS_TOOL'; id: string }
  | { type: 'TOGGLE_EXPANDED' }
  | { type: 'MOVE_FOCUS'; direction: -1 | 1; collapsibleTools: string[] }
  | { type: 'SET_TODOS'; todos: UITodoItem[] }
  | { type: 'TURN_COMPLETE'; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };

export const initialState: AgentUIState = {
  streaming: false,
  messages: [],
  streamingContent: null,
  streamingMessageId: null,
  todos: [],
  currentTools: [],
  runningSubAgents: new Map(),
  completedSubAgents: new Map(),
  focusedToolId: null,
  expandedTools: new Set<string>(),
  toolResults: new Map(),
  totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  streamingStartTime: null,
};

export function agentUIReducer(state: AgentUIState, action: AgentUIAction): AgentUIState {
  switch (action.type) {
    case 'SUBMIT_START':
      return {
        ...state,
        streaming: true,
        streamingContent: '',
        streamingMessageId: null,
        currentTools: [],
        streamingStartTime: Date.now(),
      };

    case 'TEXT_DELTA_BATCH':
      return {
        ...state,
        streamingContent: action.content,
        streamingMessageId: action.streamingMessageId,
      };

    case 'TOOL_START':
      return {
        ...state,
        currentTools: Array.from(action.runningTools.values()),
      };

    case 'TOOL_RESULT':
      return {
        ...state,
        currentTools: Array.from(action.runningTools.values()),
        toolResults: new Map(state.toolResults).set(action.toolId, action.result),
        messages: action.messages,
        todos: action.todos,
      };

    case 'TURN_COMPLETE':
      // Accumulate token usage from completed turn
      if (action.usage) {
        const newTotalUsage = {
          promptTokens: state.totalUsage.promptTokens + action.usage.prompt_tokens,
          completionTokens: state.totalUsage.completionTokens + action.usage.completion_tokens,
          totalTokens: state.totalUsage.totalTokens + action.usage.total_tokens,
        };
        return { ...state, totalUsage: newTotalUsage };
      }
      return state;

    case 'LOOP_COMPLETE':
      // Usage should already be accumulated via TURN_COMPLETE events during iteration
      // No double-counting: LOOP_COMPLETE never accumulates usage
      return {
        ...state,
        streaming: false,
        streamingContent: null,
        streamingMessageId: null,
        messages: action.messages,
        todos: action.todos,
        currentTools: [],
        streamingStartTime: null,
      };

    case 'AGENT_ERROR':
      return {
        ...state,
        messages: [...state.messages, action.errorMessage],
      };

    case 'SUB_AGENT_START':
      const nextRunning = new Map(state.runningSubAgents);
      nextRunning.set(action.event.agentId, action.event);
      return {
        ...state,
        runningSubAgents: nextRunning,
      };

    case 'SUB_AGENT_DONE':
      const nextRunningAfter = new Map(state.runningSubAgents);
      nextRunningAfter.delete(action.event.agentId);
      const nextCompleted = new Map(state.completedSubAgents);
      nextCompleted.set(action.event.agentId, {
        summary: action.event.summary,
        totalTurns: action.event.totalTurns,
        durationMs: action.event.durationMs,
        isError: action.event.isError,
      });
      return {
        ...state,
        runningSubAgents: nextRunningAfter,
        completedSubAgents: nextCompleted,
      };

    case 'FOCUS_TOOL':
      return {
        ...state,
        focusedToolId: action.id,
      };

    case 'TOGGLE_EXPANDED':
      if (!state.focusedToolId) return state;
      const nextExpanded = new Set(state.expandedTools);
      if (nextExpanded.has(state.focusedToolId)) {
        nextExpanded.delete(state.focusedToolId);
      } else {
        nextExpanded.add(state.focusedToolId);
      }
      return {
        ...state,
        expandedTools: nextExpanded,
      };

    case 'MOVE_FOCUS': {
      const { collapsibleTools, direction } = action;
      if (collapsibleTools.length === 0) {
        return { ...state, focusedToolId: null };
      }

      let currentIndex = state.focusedToolId ? collapsibleTools.indexOf(state.focusedToolId) : -1;
      let nextIndex = currentIndex + direction;
      if (nextIndex < 0) nextIndex = collapsibleTools.length - 1;
      if (nextIndex >= collapsibleTools.length) nextIndex = 0;
      const newFocusId = collapsibleTools[nextIndex];

      return {
        ...state,
        focusedToolId: newFocusId ?? null,
      };
    }

    case 'SET_TODOS':
      return {
        ...state,
        todos: action.todos,
      };

    default:
      void (0 as never);
      return state;
  }
}
