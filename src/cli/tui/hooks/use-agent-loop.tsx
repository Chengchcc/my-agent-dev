import React, { useCallback, useEffect, useMemo, useRef, useReducer } from 'react';
import { createContext as createSelectorContext, useContextSelector } from 'use-context-selector';
import type { ReactNode } from 'react';
import type { Agent } from '../../../agent';
import type { Message } from '../../../types';
import type { SubAgentStartEvent, ToolCallStartEvent } from '../../../agent/loop-types';
import type { PromptSubmission, SlashCommand } from '../command-registry';
import type { UITodoItem } from '../types';
import { agentUIReducer, initialState, type AgentUIState, type AgentUIAction } from './agent-ui-reducer';
import { getBuiltinCommands } from '../command-registry';
import { debugLog } from '../../../utils/debug';
import type { SessionStore } from '../../../session/store';

/**
 * Agent loop state for React context.
 */
type AgentLoopState = {
  agent: Agent;
  streaming: boolean;
  messages: Message[];
  /** Current streaming content being generated (separate for performance) */
  streamingContent: string | null;
  /** Current streaming thinking/reasoning content */
  thinkingContent: string | null;
  /** ID of the current streaming message */
  streamingMessageId: string | null;
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
  /** Current approximate context token count */
  currentContextTokens: number;
  /** Token limit from agent config */
  tokenLimit: number;
  /** Start time of current streaming turn (null if not streaming) */
  streamingStartTime: number | null;
  /** Whether the current agent turn was interrupted by user */
  interrupted: boolean;
  /** Tool IDs whose error action bars have been dismissed */
  ignoredErrors: Set<string>;
  /** Dismiss the error action bar for a tool */
  ignoreError: (toolId: string) => void;
};

const AgentLoopContext = createSelectorContext<AgentLoopState | null>(null);

 
// eslint-disable-next-line max-lines-per-function
export function AgentLoopProvider({
  agent,
  children,
  sessionStore,
}: {
  agent: Agent;
  children: ReactNode;
  sessionStore: SessionStore;
}) {
  const [state, dispatch] = useReducer<React.Reducer<AgentUIState, AgentUIAction>>(agentUIReducer, initialState);

  // Destructure for convenience
  const {
    streaming,
    messages,
    streamingContent,
    thinkingContent,
    streamingMessageId,
    todos,
    currentTools,
    runningSubAgents,
    completedSubAgents,
    focusedToolId,
    expandedTools,
    toolResults,
    totalUsage,
    contextTokens,
    streamingStartTime,
    interrupted,
    ignoredErrors,
  } = state;

  const streamingRef = useRef(streaming);
  const streamingContentRef = useRef('');
  const pendingFlush = useRef(false);

  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  const abort = useCallback(() => {
    agent.abort();
    dispatch({ type: 'SET_INTERRUPTED', interrupted: true });
  }, [agent]);

  const ignoreError = useCallback((toolId: string) => {
    dispatch({ type: 'IGNORE_ERROR', toolId });
  }, []);

  // Helper to refresh messages from agent context
  const refreshMessages = useCallback(() => {
    const fullContext = agent.getContext();
    dispatch({
      type: 'LOOP_COMPLETE',
      messages: fullContext.messages,
      todos: agent.getContextManager().getTodos(),
      contextTokens: agent.getContextManager().getCurrentTokens(),
    });
  }, [agent]);

  // Helper to refresh todos from agent
  const refreshTodos = useCallback(() => {
    if (typeof agent.getContextManager === 'function') {
      const updatedTodos = agent.getContextManager().getTodos();
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
    // Only consider tool calls from recent (dynamic) messages.
    // Static items use PureChatMessage which doesn't respond to expand/collapse,
    // so focusing tools in Static would appear broken.
    const DYNAMIC_RAW_WINDOW = 10;
    const dynamicMessages = messages.slice(-DYNAMIC_RAW_WINDOW);
    const toolResultsMap = new Map<string, string>();

    for (const msg of dynamicMessages) {
      if (msg.role === 'tool' && msg.content) {
        toolResultsMap.set(msg.tool_call_id!, msg.content);
      }
    }

    const collapsibleTools: string[] = [];
    for (const msg of dynamicMessages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const content = toolResultsMap.get(tc.id);
          if (content && content.split('\n').length > 3) {
            collapsibleTools.push(tc.id);
          }
        }
      }
    }

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
    // eslint-disable-next-line complexity
    async (text: string) => {
      if (streamingRef.current) return;

      // Check if it's a built-in command with handler (like session commands)
      if (text.startsWith('/')) {
        const match = text.match(/^\/([^\s]+)(?:\s(.*))?$/);
        if (match) {
          const commandName = match[1]!.toLowerCase();
          const args = match[2] || '';

          // Get all built-in commands (including session commands)
          const builtinCommands = getBuiltinCommands(sessionStore);
          const matchedCommand = builtinCommands.find(
            (cmd: SlashCommand) => cmd.name.toLowerCase() === commandName && cmd.handler,
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
        dispatch({ type: 'LOOP_COMPLETE', messages: [], todos: [], contextTokens: 0 });
        clearTerminal();
        return;
      }

      if (text.trim() === '/exit' || text.trim() === '/quit') {
        process.exit(0);
        return;
      }

      dispatch({ type: 'SUBMIT_START' });
      streamingContentRef.current = '';

      // Track incremental streaming content
      const runningTools = new Map<string, ToolCallStartEvent>();
      // Stable id for streaming message that persists across updates
      const streamingMessageId = `streaming-${Date.now()}`;

      try {
        // Run agentic loop - yields events for each step
        for await (const event of agent.runAgentLoop({ role: 'user', content: text })) {
          debugLog(`[agent-loop] event: ${event.type} t=${performance.now().toFixed(0)}`);
          if (event.type === 'thinking_delta') {
            dispatch({ type: 'THINKING_DELTA', delta: event.delta });
          } else if (event.type === 'thinking_done') {
            // thinking block completed — signature stored in agent's message blocks
            debugLog('[agent-loop] thinking_done', event.signature ? 'with signature' : '');
          } else if (event.type === 'text_delta') {
            // Only accumulate text during the current assistant turn
            // After tool execution, full messages are already in context
            if (state.streamingContent !== null || runningTools.size === 0) {
              streamingContentRef.current += event.delta;

              // Adaptive batching with queueMicrotask:
              // - Multiple deltas in the same tick are batched into one render
              // - Renders happen as soon as possible after the current tick completes
              // - No artificial 50ms delay - smooth streaming when rendering is fast
              if (!pendingFlush.current) {
                pendingFlush.current = true;
                queueMicrotask(() => {
                  pendingFlush.current = false;
                  dispatch({
                    type: 'TEXT_DELTA_BATCH',
                    streamingMessageId,
                    content: streamingContentRef.current,
                  });
                });
              }
            }
          } else if (event.type === 'tool_call_start') {
            runningTools.set(event.toolCall.id, event);
            dispatch({ type: 'TOOL_START', runningTools: new Map(runningTools) });
          } else if (event.type === 'tool_call_result') {
            runningTools.delete(event.toolCall.id);
            streamingContentRef.current = '';

            // Single atomic dispatch: meta + messages in one render cycle
            // Fix 1 ensures addMessage() runs before yield, so getContext() returns consistent state
            const fullContext = agent.getContext();
            dispatch({
              type: 'TOOL_RESULT',
              runningTools: new Map(runningTools),
              toolId: event.toolCall.id,
              result: {
                durationMs: event.durationMs,
                isError: event.isError,
              },
              messages: fullContext.messages,
              todos: agent.getContextManager().getTodos(),
              contextTokens: agent.getContextManager().getCurrentTokens(),
            });
          } else if (event.type === 'agent_error') {
            debugLog('[agent-loop] agent_error details:', event.error);
            const errorMessage: Message = {
              role: 'assistant',
              content: `Error: ${event.error.message}`,
            };
            dispatch({ type: 'AGENT_ERROR', errorMessage });
          } else if (event.type === 'turn_complete') {
            const action: AgentUIAction = {
              type: 'TURN_COMPLETE',
              ...(event.usage ? { usage: event.usage } as const : {}),
              contextTokens: agent.getContextManager().getCurrentTokens(),
            };
            dispatch(action);
            debugLog(`[agent-loop] turn_complete dispatched, for-await body ends: t=${performance.now().toFixed(0)}`);
          } else if (event.type === 'agent_done') {
            // No action needed during iteration
          } else if (event.type === 'sub_agent_start') {
            dispatch({ type: 'SUB_AGENT_START', event });
          } else if (event.type === 'sub_agent_event') {
            // Nested events are handled by the SubAgentMessage component
            // No action needed here - we just collect the start/done
          } else if (event.type === 'sub_agent_done') {
            dispatch({ type: 'SUB_AGENT_DONE', event });
          } else if (event.type === 'budget_delegation') {
            // Budget guard delegated to sub-agent
            debugLog('[agent-loop] budget delegation:', event.reason, event.originalTools);
          } else if (event.type === 'budget_compact') {
            // Budget guard triggered compaction
            debugLog('[agent-loop] budget compact:', event.reason);
          } else if (event.type === 'context_compacted') {
            // Context compaction completed — update token count since it dropped significantly
            dispatch({ type: 'SET_CONTEXT_TOKENS', tokens: agent.getContextManager().getCurrentTokens() });
            debugLog('[agent-loop] context compacted:', event.level, event.beforeTokens, '→', event.afterTokens, 'tokens');
          } else {
            // Exhaustiveness check - TypeScript will warn if new event types are added
            void (event as never);
          }
        }

        // After loop completes, get full context and update all messages
        const fullContext = agent.getContext();
        const allMessages = fullContext.messages;
        dispatch({
          type: 'LOOP_COMPLETE',
          messages: allMessages,
          todos: agent.getContextManager().getTodos(),
          contextTokens: agent.getContextManager().getCurrentTokens(),
          // Usage is already accumulated via TURN_COMPLETE events during iteration
          // Don't pass it again to avoid double-counting the last turn
        });
      } catch (error) {
        debugLog('[agent-loop] error:', error);
        console.error('Agent error:', error);
        // Add error message to messages
        const errorMessage: Message = {
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        };
        dispatch({ type: 'AGENT_ERROR', errorMessage });
        refreshTodos();
      } finally {
        // pendingFlush will complete on its own - no need to cancel
        streamingContentRef.current = '';
        // Update todos from agent one last time
        refreshTodos();
      }
    },
    [agent, sessionStore, onOutput, refreshMessages, refreshTodos],
  );

  const onSubmitWithSkill = useCallback(
    async (submission: PromptSubmission) => {
      let messageText = submission.text;
      // If a skill was requested via slash command, prepend an explicit instruction
      if (submission.requestedSkillName) {
        messageText = `Please use the "${submission.requestedSkillName}" skill for this request. ${messageText}`;
      }
      await onSubmit(messageText);
    },
    [onSubmit],
  );

  // Get token limit - use a safe default if config is not accessible
  const tokenLimit = useMemo(() => {
    try {
      return agent.config.tokenLimit || 128000;
    } catch {
      return 128000;
    }
  }, [agent]);

  // O(1) read from accumulator — tracked as first-class state field.
  // Updated on TOOL_RESULT, LOOP_COMPLETE, TURN_COMPLETE via reducer.
  // No dependency on messages — token count changes independently.
  const currentContextTokens = contextTokens;

  const value = useMemo(
    () => ({
      agent,
      streaming,
      messages,
      streamingContent,
      thinkingContent,
      streamingMessageId,
      todos,
      currentTools,
      runningSubAgents,
      completedSubAgents,
      focusedToolId,
      expandedTools,
      toolResults,
      totalUsage,
      currentContextTokens,
      tokenLimit,
      streamingStartTime,
      interrupted,
      onSubmit,
      onSubmitWithSkill,
      abort,
      ignoreError,
      setTodos: (todos: UITodoItem[]) => dispatch({ type: 'SET_TODOS', todos }),
      focusTool,
      toggleFocusedTool,
      moveFocus,
      ignoredErrors,
    }),
    [agent, messages, streamingContent, streamingMessageId, onSubmit, onSubmitWithSkill, abort, ignoreError, streaming, todos, currentTools, runningSubAgents, completedSubAgents, focusedToolId, expandedTools, toolResults, totalUsage, contextTokens, tokenLimit, streamingStartTime, interrupted, focusTool, toggleFocusedTool, moveFocus, ignoredErrors],
  );

  return (
    <AgentLoopContext.Provider value={value}>
      {children}
    </AgentLoopContext.Provider>
  );
}

function useAgentLoopState(): AgentLoopState {
  const state = useContextSelector(AgentLoopContext, s => s);
  if (!state) {
    throw new Error('useAgentLoop() must be used within <AgentLoopProvider agent={...}>');
  }
  return state;
}

export function useAgentLoopSelector<T>(selector: (state: AgentLoopState) => T): T {
  const selected = useContextSelector(AgentLoopContext, state => {
    if (!state) {
      throw new Error('useAgentLoopSelector() must be used within <AgentLoopProvider agent={...}>');
    }
    return selector(state);
  });
  return selected;
}

export function useAgentLoop() {
  return useAgentLoopState();
}

function clearTerminal() {
  if (!process.stdout.isTTY) return;
  process.stdout.write('\u001B[2J\u001B[3J\u001B[H');
}
