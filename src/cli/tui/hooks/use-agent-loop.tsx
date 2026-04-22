import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Agent } from '../../../agent';
import type { Message } from '../../../types';
import type { AgentEvent, SubAgentStartEvent, SubAgentNestedEvent, SubAgentDoneEvent, ToolCallStartEvent } from '../../../agent/loop-types';
import type { PromptSubmission } from '../command-registry';
import type { UITodoItem } from '../types';
import { getBuiltinCommands } from '../command-registry';
import type { SessionStore } from '../../../session/store';

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
  const [streaming, setStreaming] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [todos, setTodos] = useState<UITodoItem[]>([]);
  const [currentTools, setCurrentTools] = useState<ToolCallStartEvent[]>([]);
  const [runningSubAgents, setRunningSubAgents] = useState<Map<string, SubAgentStartEvent>>(new Map());
  const [completedSubAgents, setCompletedSubAgents] = useState<Map<string, { summary: string; totalTurns: number; durationMs: number; isError: boolean }>>(new Map());
  const [focusedToolId, setFocusedToolId] = useState<string | null>(null);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [toolResults, setToolResults] = useState<Map<string, { isError: boolean; durationMs: number }>>(new Map());

  const streamingRef = useRef(streaming);
  const streamingMessageRef = useRef<Message | null>(null);

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
    setMessages([...fullContext.messages]);
  }, [agent]);

  // Helper to refresh todos from agent
  const refreshTodos = useCallback(() => {
    // Get todos from context manager where they are stored
    const agentWithContextManager = agent as Agent & { getContextManager(): { getTodos: () => UITodoItem[] } };
    if (typeof agentWithContextManager.getContextManager === 'function') {
      const updatedTodos = agentWithContextManager.getContextManager().getTodos();
      setTodos(updatedTodos);
    }
  }, [agent]);

  const focusTool = useCallback((id: string) => {
    setFocusedToolId(id);
  }, []);

  const toggleFocusedTool = useCallback(() => {
    if (!focusedToolId) return;
    setExpandedTools(prev => {
      const next = new Set(prev);
      if (next.has(focusedToolId)) {
        next.delete(focusedToolId);
      } else {
        next.add(focusedToolId);
      }
      return next;
    });
  }, [focusedToolId]);

  const getCollapsibleTools = useCallback((): string[] => {
    // Get all tool calls from assistant messages that have result and are collapsible
    const collapsibleTools: string[] = [];

    messages.forEach(msg => {
      if (msg.role === 'assistant' && msg.tool_calls) {
        msg.tool_calls.forEach(tc => {
          // A tool is collapsible if it has a result > 3 lines and not an error
          // We need to look up the corresponding tool message
          const toolMessage = messages.find(m => m.role === 'tool' && m.tool_call_id === tc.id);
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
    if (collapsibleTools.length === 0) {
      setFocusedToolId(null);
      return;
    }

    if (!focusedToolId) {
      // If no focus, go to first when moving down, last when moving up
      const newFocusId = direction === 1 ? collapsibleTools[0] : collapsibleTools[collapsibleTools.length - 1];
      setFocusedToolId(newFocusId);
      return;
    }

    const currentIndex = collapsibleTools.indexOf(focusedToolId);
    if (currentIndex === -1) {
      setFocusedToolId(collapsibleTools[0]);
      return;
    }

    let nextIndex = currentIndex + direction;
    if (nextIndex < 0) nextIndex = collapsibleTools.length - 1;
    if (nextIndex >= collapsibleTools.length) nextIndex = 0;
    setFocusedToolId(collapsibleTools[nextIndex]);
  }, [focusedToolId, getCollapsibleTools]);

  // Helper to output system messages
  const onOutput = useCallback((content: string) => {
    const systemMessage: Message = {
      role: 'assistant',
      content,
    };
    setMessages(prev => [...prev, systemMessage]);
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
            cmd => cmd.name.toLowerCase() === commandName && cmd.handler,
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
        setMessages([]);
        clearTerminal();
        return;
      }

      if (text.trim() === '/exit' || text.trim() === '/quit') {
        process.exit(0);
        return;
      }

      setStreaming(true);
      streamingMessageRef.current = null;

      // Track incremental streaming content
      let streamingContent = '';
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
              streamingContent += event.delta;

              // Update the streaming message - reuse the same stable id
              const oldStreamingMessage = streamingMessageRef.current;
              const streamingMessage: Message = {
                id: streamingMessageId,
                role: 'assistant',
                content: streamingContent,
              };
              streamingMessageRef.current = streamingMessage;

              setMessages(prev => {
                const base = prev.filter(m => m.id !== streamingMessageId);
                return [...base, streamingMessage];
              });
            }
          } else if (event.type === 'tool_call_start') {
            runningTools.set(event.toolCall.id, event);
            setCurrentTools(Array.from(runningTools.values()));
            // Refresh to show running tool
            refreshMessages();
            refreshTodos();
          } else if (event.type === 'tool_call_result') {
            runningTools.delete(event.toolCall.id);
            setCurrentTools(Array.from(runningTools.values()));
            // Store duration metadata
            setToolResults(prev => {
              const next = new Map(prev);
              next.set(event.toolCall.id, {
                durationMs: event.durationMs,
                isError: event.isError,
              });
              return next;
            });

            // After tool result completes, refresh from full context
            // This ensures tool messages are shown separately immediately
            streamingContent = '';
            streamingMessageRef.current = null;
            refreshMessages();
            refreshTodos();
          } else if (event.type === 'agent_error') {
            // Add error message to messages
            const errorMessage: Message = {
              role: 'assistant',
              content: `Error: ${event.error.message}`,
            };
            setMessages(prev => [...prev, errorMessage]);
          } else if (event.type === 'turn_complete' || event.type === 'agent_done') {
            // No action needed during iteration
          } else if (event.type === 'sub_agent_start') {
            runningSubAgents.set(event.agentId, event);
            setRunningSubAgents(new Map(runningSubAgents));
          } else if (event.type === 'sub_agent_event') {
            // Nested events are handled by the SubAgentMessage component
            // No action needed here - we just collect the start/done
          } else if (event.type === 'sub_agent_done') {
            runningSubAgents.delete(event.agentId);
            completedSubAgents.set(event.agentId, {
              summary: event.summary,
              totalTurns: event.totalTurns,
              durationMs: event.durationMs,
              isError: event.isError,
            });
            setRunningSubAgents(new Map(runningSubAgents));
            setCompletedSubAgents(new Map(completedSubAgents));
          } else {
            // Exhaustiveness check - TypeScript will warn if new event types are added
            const _exhaustive: never = event;
          }
        }

        // After loop completes, get full context and update all messages
        const fullContext = agent.getContext();
        const allMessages = fullContext.messages;
        setMessages([...allMessages]);
        streamingMessageRef.current = null;
        setCurrentTools([]);
      } catch (error) {
        console.error('Agent error:', error);
        // Add error message to messages
        const errorMessage: Message = {
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        };
        setMessages(prev => [...prev, errorMessage]);
        refreshTodos();
      } finally {
        // Update todos from agent one last time
        refreshTodos();

        setStreaming(false);
        streamingMessageRef.current = null;
        setCurrentTools([]);
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
      onSubmit,
      onSubmitWithSkill,
      abort,
      setTodos,
      focusTool,
      toggleFocusedTool,
      moveFocus,
    }),
    [agent, messages, onSubmit, onSubmitWithSkill, abort, streaming, todos, currentTools, runningSubAgents, completedSubAgents, setTodos, focusedToolId, expandedTools, toolResults, focusTool, toggleFocusedTool, moveFocus],
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
