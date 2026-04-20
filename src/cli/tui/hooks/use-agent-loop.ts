import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Agent } from '../../../agent';
import type { Message } from '../../../types';
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
  const pendingMessagesRef = useRef<Message[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  const flushPendingMessages = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    if (pendingMessagesRef.current.length === 0) return;

    const pending = pendingMessagesRef.current;
    pendingMessagesRef.current = [];
    setMessages((prev) => [...prev, ...pending]);
  }, []);

  const enqueueMessage = useCallback(
    (message: Message) => {
      pendingMessagesRef.current.push(message);
      if (flushTimerRef.current) return;

      flushTimerRef.current = setTimeout(() => {
        flushPendingMessages();
      }, 50);
    },
    [flushPendingMessages],
  );

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
      }
    };
  }, []);

  const abort = useCallback(() => {
    // Agent doesn't have abort yet in our implementation - placeholder for future
    if (typeof (agent as any).abort === 'function') {
      (agent as any).abort();
    }
  }, [agent]);

  const onSubmit = useCallback(
    async (text: string) => {
      if (streamingRef.current) return;

      // Handle built-in commands
      if (text.trim() === '/clear' || text.trim() === '/cls') {
        agent.clear();
        flushPendingMessages();
        setMessages([]);
        clearTerminal();
        return;
      }

      if (text.trim() === '/exit' || text.trim() === '/quit') {
        process.exit(0);
        return;
      }

      setStreaming(true);

      try {
        const userMessage: Message = {
          role: 'user',
          content: text,
        };
        enqueueMessage(userMessage);

        // Run streaming
        for await (const chunk of agent.runStream({ role: 'user', content: text })) {
          if (chunk.content) {
            // The full response gets added after streaming completes
            // Ink handles incremental display via React state
          }
        }

        // After streaming completes, get full context and update messages
        const fullContext = agent.getContext();
        const allMessages = fullContext.messages;
        setMessages([...allMessages]);
      } catch (error) {
        console.error('Agent error:', error);
        throw error;
      } finally {
        flushPendingMessages();
        setStreaming(false);
      }
    },
    [agent, enqueueMessage, flushPendingMessages],
  );

  const value = useMemo(
    () => ({
      agent,
      streaming,
      messages,
      todos,
      onSubmit,
      abort,
      setTodos,
    }),
    [abort, agent, messages, onSubmit, streaming, todos, setTodos],
  );

  return createElement(AgentLoopContext.Provider, { value }, children);
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