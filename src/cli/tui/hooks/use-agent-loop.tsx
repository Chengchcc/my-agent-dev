import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Agent } from '../../../agent';
import type { Message } from '../../../types';
import type { AgentEvent, ToolCallStartEvent } from '../../../agent/loop-types';
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
  onSubmit: (text: string) => Promise<void>;
  onSubmitWithSkill: (submission: PromptSubmission) => void;
  abort: () => void;
  setTodos: (todos: UITodoItem[]) => void;
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

      try {
        // Run agentic loop - yields events for each step
        for await (const event of agent.runAgentLoop({ role: 'user', content: text })) {
          if (event.type === 'text_delta') {
            // Only accumulate text during the current assistant turn
            // After tool execution, full messages are already in context
            if (streamingMessageRef.current !== null || runningTools.size === 0) {
              streamingContent += event.delta;

              // Update the streaming message
              const oldStreamingMessage = streamingMessageRef.current;
              const streamingMessage: Message = {
                role: 'assistant',
                content: streamingContent,
              };
              streamingMessageRef.current = streamingMessage;

              setMessages(prev => {
                const base = prev.filter(m => m !== oldStreamingMessage);
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
          } else if (event.type === 'sub_agent_start' || event.type === 'sub_agent_event' || event.type === 'sub_agent_done') {
            // Sub agent events - currently not displayed in UI
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
    (submission: PromptSubmission) => {
      // The skill name is captured in the submission - the agent will handle it
      onSubmit(submission.text);
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
      onSubmit,
      onSubmitWithSkill,
      abort,
      setTodos,
    }),
    [abort, agent, messages, onSubmit, onSubmitWithSkill, streaming, todos, currentTools, setTodos],
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
