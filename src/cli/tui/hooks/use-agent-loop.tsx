import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Agent } from '../../../agent';
import type { Message } from '../../../types';
import type { PromptSubmission } from '../command-registry';
import type { UITodoItem } from '../types';

/**
 * Agent loop state for React context.
 */
type AgentLoopState = {
  agent: Agent;
  streaming: boolean;
  messages: Message[];
  todos: UITodoItem[];
  onSubmit: (text: string) => Promise<void>;
  onSubmitWithSkill: (submission: PromptSubmission) => void;
  abort: () => void;
  setTodos: (todos: UITodoItem[]) => void;
};

const AgentLoopContext = createContext<AgentLoopState | null>(null);

export function AgentLoopProvider({
  agent,
  children,
}: {
  agent: Agent;
  children: ReactNode;
}) {
  const [streaming, setStreaming] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [todos, setTodos] = useState<UITodoItem[]>([]);

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

  const onSubmit = useCallback(
    async (text: string) => {
      if (streamingRef.current) return;

      // Handle built-in commands
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

      try {
        // Run streaming - agent already adds user message to context
        for await (const chunk of agent.runStream({ role: 'user', content: text })) {
          if (chunk.content) {
            streamingContent += chunk.content;

            // Update the streaming message directly in messages state
            const oldStreamingMessage = streamingMessageRef.current;
            const streamingMessage: Message = {
              role: 'assistant',
              content: streamingContent,
            };
            streamingMessageRef.current = streamingMessage;

            setMessages(prev => {
              // Filter out any previous streaming message
              const base = prev.filter(m => m !== oldStreamingMessage);
              return [...base, streamingMessage];
            });
          }
        }

        // After streaming completes, get full context and update messages
        const fullContext = agent.getContext();
        const allMessages = fullContext.messages;
        setMessages([...allMessages]);
        streamingMessageRef.current = null;
      } catch (error) {
        console.error('Agent error:', error);
        // Add error message to messages
        const errorMessage: Message = {
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        };
        setMessages(prev => [...prev, errorMessage]);
      } finally {
        // Update todos from agent if available
        if (typeof (agent as Agent & { getTodos: () => UITodoItem[] }).getTodos === 'function') {
          const updatedTodos = (agent as Agent & { getTodos: () => UITodoItem[] }).getTodos();
          setTodos(updatedTodos);
        } else if (typeof (agent as Agent & { todos: UITodoItem[] }).todos !== 'undefined') {
          setTodos((agent as Agent & { todos: UITodoItem[] }).todos);
        }

        setStreaming(false);
        streamingMessageRef.current = null;
      }
    },
    [agent],
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
      onSubmit,
      onSubmitWithSkill,
      abort,
      setTodos,
    }),
    [abort, agent, messages, onSubmit, onSubmitWithSkill, streaming, todos, setTodos],
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
