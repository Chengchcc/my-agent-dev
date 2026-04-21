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

  // We use a state counter to force re-renders when pending messages change
  const [flushCounter, setFlushCounter] = useState(0);

  const flushPendingMessages = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    if (pendingMessagesRef.current.length === 0) return;

    // Replace the last message in messages with our pending streaming message
    // This handles incremental updates to the same message during streaming
    setMessages((prev) => {
      if (pendingMessagesRef.current.length === 1 && prev.length > 0) {
        // Check if the last message is still being streamed (not added to agent context yet)
        const lastMessage = prev[prev.length - 1];
        if (lastMessage.role === 'assistant' && lastMessage.content.startsWith(pendingMessagesRef.current[0].content.slice(0, 10))) {
          // Replace the last message with the updated version
          return [...prev.slice(0, -1), ...pendingMessagesRef.current];
        }
      }
      // Normal append for new messages
      return [...prev, ...pendingMessagesRef.current];
    });

    pendingMessagesRef.current = [];
    setFlushCounter(c => c + 1);
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;

    flushTimerRef.current = setTimeout(() => {
      flushPendingMessages();
    }, MESSAGE_BATCH_INTERVAL_MS);
  }, [flushPendingMessages]);

  const enqueueMessage = useCallback(
    (message: Message) => {
      if (streamingMessageIndexRef.current !== null && pendingMessagesRef.current.length > 0) {
        // Update existing streaming message
        pendingMessagesRef.current[pendingMessagesRef.current.length - 1] = message;
      } else {
        // Add new streaming message
        pendingMessagesRef.current.push(message);
      }
      scheduleFlush();
    },
    [scheduleFlush],
  );

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
      }
    };
  }, []);

  // Track streaming message index for incremental updates
  const streamingMessageIndexRef = useRef<number | null>(null);

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
      streamingMessageIndexRef.current = null;

      // Track incremental streaming content
      let streamingContent = '';

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

            enqueueMessage(streamingMessage);
          }
        }

        // After streaming completes, get full context and update messages
        const fullContext = agent.getContext();
        const allMessages = fullContext.messages;
        setMessages([...allMessages]);
        // Clear pending since we're replacing with full context
        pendingMessagesRef.current = [];
        streamingMessageIndexRef.current = null;
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
        streamingMessageIndexRef.current = null;
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