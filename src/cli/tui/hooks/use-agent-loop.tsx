import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useReducer } from 'react';
import type { ReactNode } from 'react';
import type { Agent } from '../../../agent';
import type { Message } from '../../../types';
import type { AgentEvent, SubAgentStartEvent, SubAgentNestedEvent, SubAgentDoneEvent, ToolCallStartEvent } from '../../../agent/loop-types';
import type { PromptSubmission } from '../command-registry';
import type { UITodoItem } from '../types';
import { getBuiltinCommands } from '../command-registry';
import type { SessionStore } from '../../../session/store';

type AgentUIState = {
  streaming: boolean;
  messages: Message[];
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

type AgentUIAction =
  | { type: 'SUBMIT_START' }
  | { type: 'TEXT_DELTA_BATCH'; streamingMessageId: string; message: Message }
  | { type: 'TOOL_START'; runningTools: Map<string, ToolCallStartEvent> }
  | { type: 'TOOL_RESULT'; runningTools: Map<string, ToolCallStartEvent>; toolId: string; result: { durationMs: number; isError: boolean }; messages: Message[]; todos: UITodoItem[] }
  | { type: 'LOOP_COMPLETE'; messages: Message[]; todos: UITodoItem[]; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { type: 'AGENT_ERROR'; errorMessage: Message }
  | { type: 'SUB_AGENT_START'; event: SubAgentStartEvent }
  | { type: 'SUB_AGENT_DONE'; event: SubAgentDoneEvent }
  | { type: 'FOCUS_TOOL'; id: string }
  | { type: 'TOGGLE_EXPANDED' }
  | { type: 'MOVE_FOCUS'; direction: -1 | 1; collapsibleTools: string[] }
  | { type: 'SET_TODOS'; todos: UITodoItem[] };

function agentUIReducer(state: AgentUIState, action: AgentUIAction): AgentUIState {
  switch (action.type) {
    case 'SUBMIT_START':
      return {
        ...state,
        streaming: true,
        currentTools: [],
        streamingStartTime: Date.now(),
      };

    case 'TEXT_DELTA_BATCH':
      return {
        ...state,
        messages: [
          ...state.messages.filter((m: Message) => m.id !== action.streamingMessageId),
          action.message,
        ],
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

    case 'LOOP_COMPLETE':
      // Accumulate token usage if provided
      let newTotalUsage = state.totalUsage;
      if (action.usage) {
        newTotalUsage = {
          promptTokens: state.totalUsage.promptTokens + action.usage.prompt_tokens,
          completionTokens: state.totalUsage.completionTokens + action.usage.completion_tokens,
          totalTokens: state.totalUsage.totalTokens + action.usage.total_tokens,
        };
      }
      return {
        ...state,
        streaming: false,
        messages: action.messages,
        todos: action.todos,
        currentTools: [],
        totalUsage: newTotalUsage,
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
        focusedToolId: newFocusId,
      };
    }

    case 'SET_TODOS':
      return {
        ...state,
        todos: action.todos,
      };

    default:
      const _exhaustive: never = action;
      return state;
  }
}

/**
 * Agent loop state for React context.
 */
type AgentLoopState = {
  agent: Agent;
  streaming: boolean;
  messages: Message[];
  todos: UITodoItem[];
  currentTools: ToolCallStartEvent[];
  runningSubAgents: Map<string, SubAgentStartEvent>;
  completedSubAgents: Map<string, { summary: string; totalTurns: number; durationMs: number; isError: boolean }>;
  /** ID of currently focused tool for keyboard interaction */
  focusedToolId: string | null;
  /** Set of tool IDs that are currently expanded */
  expandedTools: Set<string>;
  onSubmit: (text: string) => Promise<void>;
  onSubmitWithSkill: (submission: PromptSubmission) => void;
  abort: () => void;
  setTodos: (todos: UITodoItem[]) => void;
  /** Focus a specific tool by ID */
  focusTool: (id: string) => void;
  /** Toggle expanded state of currently focused tool */
  toggleFocusedTool: () => void;
  /** Move focus to previous/next tool (direction: -1 = previous, 1 = next) */
  moveFocus: (direction: -1 | 1) => void;
  /** Cached metadata for completed tool results */
  toolResults: Map<string, { durationMs: number; isError: boolean }>;
  /** Accumulated total token usage across all turns */
  totalUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Token limit from agent config */
  tokenLimit: number;
  /** Start time of current streaming turn (null if not streaming) */
  streamingStartTime: number | null;
};

const AgentLoopContext = createContext<AgentLoopState | null>(null);

export function AgentLoopProvider({
  agent,
  children,
  sessionStore,
}: {
  agent: Agent;
  children: ReactNode;
  sessionStore: SessionStore;
}) {
  const [state, dispatch] = useReducer<React.Reducer<AgentUIState, AgentUIAction>>(agentUIReducer, {
    streaming: false,
    messages: [],
    todos: [],
    currentTools: [],
    runningSubAgents: new Map(),
    completedSubAgents: new Map(),
    focusedToolId: null,
    expandedTools: new Set<string>(),
    toolResults: new Map(),
    totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    streamingStartTime: null,
  });

  // Destructure for convenience
  const {
    streaming,
    messages,
    todos,
    currentTools,
    runningSubAgents,
    completedSubAgents,
    focusedToolId,
    expandedTools,
    toolResults,
    totalUsage,
    streamingStartTime,
  } = state;

  const streamingRef = useRef(streaming);
  const streamingMessageRef = useRef<Message | null>(null);
  const streamingContentRef = useRef('');
  const batchTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  const abort = useCallback(() => {
    if (typeof (agent as any).abort === 'function') {
      (agent as any).abort();
    }
  }, [agent]);

  // Helper to refresh messages from agent context
  const refreshMessages = useCallback(() => {
    const fullContext = agent.getContext();
    const agentWithContextManager = agent as Agent & { getContextManager(): { getTodos: () => UITodoItem[] } };
    dispatch({
      type: 'LOOP_COMPLETE',
      messages: fullContext.messages,
      todos: agentWithContextManager.getContextManager().getTodos(),
    });
  }, [agent]);

  // Helper to refresh todos from agent
  const refreshTodos = useCallback(() => {
    const agentWithContextManager = agent as Agent & { getContextManager(): { getTodos: () => UITodoItem[] } };
    if (typeof agentWithContextManager.getContextManager === 'function') {
      const updatedTodos = agentWithContextManager.getContextManager().getTodos();
      dispatch({ type: 'SET_TODOS', todos: updatedTodos });
    }
  }, [agent]);

  const focusTool = useCallback((id: string) => {
    dispatch({ type: 'FOCUS_TOOL', id });
  }, []);

  const toggleFocusedTool = useCallback(() => {
    dispatch({ type: 'TOGGLE_EXPANDED' });
  }, []);

  const getCollapsibleTools = useCallback((): string[] => {
    // Get all tool calls from assistant messages that have result and are collapsible
    const collapsibleTools: string[] = [];

    messages.forEach((msg: Message) => {
      if (msg.role === 'assistant' && msg.tool_calls) {
        msg.tool_calls.forEach((tc: any) => {
          // A tool is collapsible if it has a result > 3 lines and not an error
          // We need to look up the corresponding tool message
          const toolMessage = messages.find((m: Message) => m.role === 'tool' && m.tool_call_id === tc.id);
          if (!toolMessage?.content) return;

          const lines = toolMessage.content.split('\n');
          if (lines.length > 3) {
            collapsibleTools.push(tc.id);
          }
        });
      }
    });

    return collapsibleTools;
  }, [messages]);

  const moveFocus = useCallback((direction: -1 | 1) => {
    const collapsibleTools = getCollapsibleTools();
    dispatch({ type: 'MOVE_FOCUS', direction, collapsibleTools });
  }, [getCollapsibleTools]);

  // Helper to output system messages
  const onOutput = useCallback((content: string) => {
    const systemMessage: Message = {
      role: 'assistant',
      content,
    };
    dispatch({ type: 'AGENT_ERROR', errorMessage: systemMessage });
  }, []);

  const onSubmit = useCallback(
    async (text: string) => {
      if (streamingRef.current) return;

      // Check if it's a built-in command with handler (like session commands)
      if (text.startsWith('/')) {
        const match = text.match(/^\/([^\s]+)(?:\s(.*))?$/);
        if (match) {
          const commandName = match[1].toLowerCase();
          const args = match[2] || '';

          // Get all built-in commands (including session commands)
          const builtinCommands = getBuiltinCommands(sessionStore);
          const matchedCommand = builtinCommands.find(
            (cmd: any) => cmd.name.toLowerCase() === commandName && cmd.handler,
          );

          if (matchedCommand) {
            await matchedCommand.handler!({
              agent,
              sessionStore,
              onOutput,
              refreshMessages,
              args,
            });
            return;
          }
        }
      }

      // Handle basic built-in commands
      if (text.trim() === '/clear' || text.trim() === '/cls') {
        if (typeof agent.clear === 'function') {
          agent.clear();
        }
        dispatch({ type: 'LOOP_COMPLETE', messages: [], todos: [] });
        clearTerminal();
        return;
      }

      if (text.trim() === '/exit' || text.trim() === '/quit') {
        process.exit(0);
        return;
      }

      dispatch({ type: 'SUBMIT_START' });
      streamingMessageRef.current = null;
      streamingContentRef.current = '';

      // Track incremental streaming content
      const runningTools = new Map<string, ToolCallStartEvent>();
      // Stable id for streaming message that persists across updates
      const streamingMessageId = `streaming-${Date.now()}`;

      try {
        // Run agentic loop - yields events for each step
        for await (const event of agent.runAgentLoop({ role: 'user', content: text })) {
          if (event.type === 'text_delta') {
            // Only accumulate text during the current assistant turn
            // After tool execution, full messages are already in context
            if (streamingMessageRef.current !== null || runningTools.size === 0) {
              streamingContentRef.current += event.delta;

              // Batch updates: max one render per 50ms to reduce flicker
              if (!batchTimerRef.current) {
                batchTimerRef.current = setTimeout(() => {
                  batchTimerRef.current = null;
                  const streamingMessage: Message = {
                    id: streamingMessageId,
                    role: 'assistant',
                    content: streamingContentRef.current,
                  };
                  streamingMessageRef.current = streamingMessage;
                  dispatch({ type: 'TEXT_DELTA_BATCH', streamingMessageId, message: streamingMessage });
                }, 50);
              }
            }
          } else if (event.type === 'tool_call_start') {
            runningTools.set(event.toolCall.id, event);
            dispatch({ type: 'TOOL_START', runningTools: new Map(runningTools) });
          } else if (event.type === 'tool_call_result') {
            runningTools.delete(event.toolCall.id);
            // After tool result completes, refresh from full context
            // This ensures tool messages are shown separately immediately
            streamingContentRef.current = '';
            streamingMessageRef.current = null;
            const fullContext = agent.getContext();
            const agentWithContextManager = agent as Agent & { getContextManager(): { getTodos: () => UITodoItem[] } };
            dispatch({
              type: 'TOOL_RESULT',
              runningTools,
              toolId: event.toolCall.id,
              result: { durationMs: event.durationMs, isError: event.isError },
              messages: fullContext.messages,
              todos: agentWithContextManager.getContextManager().getTodos(),
            });
          } else if (event.type === 'agent_error') {
            const errorMessage: Message = {
              role: 'assistant',
              content: `Error: ${event.error.message}`,
            };
            dispatch({ type: 'AGENT_ERROR', errorMessage });
          } else if (event.type === 'turn_complete' || event.type === 'agent_done') {
            // No action needed during iteration
          } else if (event.type === 'sub_agent_start') {
            dispatch({ type: 'SUB_AGENT_START', event });
          } else if (event.type === 'sub_agent_event') {
            // Nested events are handled by the SubAgentMessage component
            // No action needed here - we just collect the start/done
          } else if (event.type === 'sub_agent_done') {
            dispatch({ type: 'SUB_AGENT_DONE', event });
          } else {
            // Exhaustiveness check - TypeScript will warn if new event types are added
            const _exhaustive: never = event;
          }
        }

        // After loop completes, get full context and update all messages
        const fullContext = agent.getContext();
        const allMessages = fullContext.messages;
        const agentWithContextManager = agent as Agent & { getContextManager(): { getTodos: () => UITodoItem[] } };
        const lastContext = agent.getContext();
        const usage = lastContext.response?.usage;
        dispatch({
          type: 'LOOP_COMPLETE',
          messages: allMessages,
          todos: agentWithContextManager.getContextManager().getTodos(),
          usage,
        });
        streamingMessageRef.current = null;
      } catch (error) {
        console.error('Agent error:', error);
        // Add error message to messages
        const errorMessage: Message = {
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        };
        dispatch({ type: 'AGENT_ERROR', errorMessage });
        refreshTodos();
      } finally {
        // Clear any pending batch timer
        if (batchTimerRef.current) {
          clearTimeout(batchTimerRef.current);
          batchTimerRef.current = null;
        }
        // Update todos from agent one last time
        refreshTodos();
      }
    },
    [agent, sessionStore, onOutput, refreshMessages, refreshTodos],
  );

  const onSubmitWithSkill = useCallback(
    async (submission: PromptSubmission) => {
      // The skill name is captured in the submission - the agent will handle it
      await onSubmit(submission.text);
    },
    [onSubmit],
  );

  // Get token limit - use a safe default if config is not accessible
  const tokenLimit = useMemo(() => {
    try {
      return (agent as any).config?.tokenLimit || 128000;
    } catch {
      return 128000;
    }
  }, [agent]);

  const value = useMemo(
    () => ({
      agent,
      streaming,
      messages,
      todos,
      currentTools,
      runningSubAgents,
      completedSubAgents,
      focusedToolId,
      expandedTools,
      toolResults,
      totalUsage,
      tokenLimit,
      streamingStartTime,
      onSubmit,
      onSubmitWithSkill,
      abort,
      setTodos: (todos: UITodoItem[]) => dispatch({ type: 'SET_TODOS', todos }),
      focusTool,
      toggleFocusedTool,
      moveFocus,
    }),
    [agent, messages, onSubmit, onSubmitWithSkill, abort, streaming, todos, currentTools, runningSubAgents, completedSubAgents, focusedToolId, expandedTools, toolResults, totalUsage, tokenLimit, streamingStartTime, focusTool, toggleFocusedTool, moveFocus],
  );

  return (
    <AgentLoopContext.Provider value={value}>
      {children}
    </AgentLoopContext.Provider>
  );
}

function useAgentLoopState(): AgentLoopState {
  const state = useContext(AgentLoopContext);
  if (!state) {
    throw new Error('useAgentLoop() must be used within <AgentLoopProvider agent={...}>');
  }
  return state;
}

export function useAgentLoop() {
  return useAgentLoopState();
}

function clearTerminal() {
  if (!process.stdout.isTTY) return;
  process.stdout.write('\u001B[2J\u001B[3J\u001B[H');
}
