import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Agent } from '../../../agent';
import type { Message, LLMResponseChunk } from '../../../types';
import type { PromptSubmission } from '../command-registry';
import type { UITodoItem } from '../types';

/**
 * Interval in milliseconds for batching message updates
 */
const MESSAGE_BATCH_INTERVAL_MS = 50;

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
      }, MESSAGE_BATCH_INTERVAL_MS);
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
        if (typeof agent.clear === 'function') {
          agent.clear();
        }
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

      // Track incremental streaming content
      let streamingContent = '';
      let streamingMessageIndex: number | null = null;

      try {
        // Run streaming - agent already adds user message to context
        for await (const chunk of agent.runStream({ role: 'user', content: text })) {
          if (chunk.content) {
            streamingContent += chunk.content;

            // Create or update the streaming assistant message
            const streamingMessage: Message = {
              role: 'assistant',
              content: streamingContent,
            };

            if (streamingMessageIndex === null) {
              // First chunk - add new streaming message
              enqueueMessage(streamingMessage);
              streamingMessageIndex = pendingMessagesRef.current.length - 1;
            } else {
              // Update existing streaming message
              pendingMessagesRef.current[streamingMessageIndex] = streamingMessage;
            }
          }
        }

        // After streaming completes, get full context and update messages
        const fullContext = agent.getContext();
        const allMessages = fullContext.messages;
        setMessages([...allMessages]);
        // Clear pending since we're replacing with full context
        pendingMessagesRef.current = [];
        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
      } catch (error) {
        console.error('Agent error:', error);
        // Add error message to messages so user sees it
        const errorMessage: Message = {
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        };
        enqueueMessage(errorMessage);
      } finally {
        // Update todos from agent if available
        if (typeof (agent as Agent & { getTodos: () => UITodoItem[] }).getTodos === 'function') {
          const updatedTodos = (agent as Agent & { getTodos: () => UITodoItem[] }).getTodos();
          setTodos(updatedTodos);
        } else if (typeof (agent as Agent & { todos: UITodoItem[] }).todos !== 'undefined') {
          setTodos((agent as Agent & { todos: UITodoItem[] }).todos);
        }

        flushPendingMessages();
        setStreaming(false);
      }
    },
    [agent, enqueueMessage, flushPendingMessages],
  );

  const onSubmitWithSkill = useCallback(
    (submission: PromptSubmission) => {
      // For now, just submit the text as-is
      // Skill invocation will be handled by the agent when parsing the prompt
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