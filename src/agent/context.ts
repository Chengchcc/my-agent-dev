import { nanoid } from 'nanoid';
import { countTokens } from '@anthropic-ai/tokenizer';
import type { AgentContext, AgentConfig, CompressionStrategy, Message } from '../types';
import type { TodoItem } from '../todos/types';

/**
 * Count total tokens in an array of messages.
 */
function countTotalTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + countTokens(msg.content), 0);
}

/**
 * Default compression strategy - trim oldest messages when over limit.
 * Keeps system prompt if present.
 */
export class TrimOldestStrategy implements CompressionStrategy {
  async compress(context: AgentContext, tokenLimit: number): Promise<Message[]> {
    let messages = [...context.messages];

    // Keep all system messages separate
    const systemMessages = messages.filter(m => m.role === 'system');
    if (systemMessages.length > 0) {
      messages = messages.filter(m => m.role !== 'system');
    }

    // Count total tokens including system prompt
    const systemTokenCount = context.systemPrompt ? countTokens(context.systemPrompt) : 0;
    let currentTotalTokens = systemTokenCount + countTotalTokens(messages);

    // Remove oldest messages until we're under the limit or empty
    while (currentTotalTokens > tokenLimit && messages.length > 0) {
      // Never remove the last two messages - keep the current turn
      if (messages.length <= 2) break;

      // Check if the first message is an assistant with tool_calls. If so, remove it plus all matching tool results.
      const first = messages[0];
      if (first.role === 'assistant' && first.tool_calls && first.tool_calls.length > 0 && messages.length >= 1 + first.tool_calls.length) {
        // Remove the assistant message + all tool result messages that match its tool calls
        // Each tool call has exactly one tool result message immediately after
        messages = messages.slice(1 + first.tool_calls.length);
      } else {
        // Just remove the single message
        messages = messages.slice(1);
      }
      // Recalculate total tokens after removal
      currentTotalTokens = systemTokenCount + countTotalTokens(messages);
    }

    // Put all system messages back at the beginning
    messages.unshift(...systemMessages);

    return messages;
  }
}

/**
 * Manages conversation context with compression.
 */
export class ContextManager {
  private messages: Message[];
  private tokenLimit: number;
  private compressionStrategy: CompressionStrategy;
  private defaultSystemPrompt?: string;
  private currentSystemPrompt?: string;
  private todoStore: TodoItem[] = [];
  private todoStepsSinceLastWrite = Infinity;
  private todoStepsSinceLastReminder = Infinity;

  constructor(options: {
    tokenLimit: number;
    compressionStrategy?: CompressionStrategy;
    defaultSystemPrompt?: string;
  }) {
    this.tokenLimit = options.tokenLimit;
    this.compressionStrategy = options.compressionStrategy ?? new TrimOldestStrategy();
    this.messages = [];
    this.defaultSystemPrompt = options.defaultSystemPrompt;
    this.currentSystemPrompt = options.defaultSystemPrompt;

    if (this.defaultSystemPrompt) {
      this.messages.push({
        role: 'system',
        content: this.defaultSystemPrompt,
      });
    }
  }

  /**
   * Add a message to the context.
   * Automatically assigns a unique id if not provided.
   */
  addMessage(message: Message): void {
    this.messages.push({
      ...message,
      id: message.id ?? nanoid(),
    });
  }

  /**
   * Get current messages.
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Update the current system prompt (for dynamic skill injection).
   */
  setSystemPrompt(systemPrompt?: string): void {
    this.currentSystemPrompt = systemPrompt;
  }

  /**
   * Get the current system prompt.
   */
  getSystemPrompt(): string | undefined {
    return this.currentSystemPrompt;
  }

  /**
   * Get AgentContext for passing through pipeline.
   */
  getContext(config: AgentConfig): AgentContext {
    return {
      messages: [...this.messages],
      config,
      metadata: {
        // Embed current todo state into metadata for tools and middleware
        todo: {
          todoStore: [...this.todoStore],
          stepsSinceLastWrite: this.todoStepsSinceLastWrite,
          stepsSinceLastReminder: this.todoStepsSinceLastReminder,
        },
      },
      systemPrompt: this.currentSystemPrompt,
    };
  }

  /**
   * Update todo state from metadata after processing.
   * This needs to be called after the middleware/tool execution to persist changes.
   */
  syncTodoFromContext(context: AgentContext): void {
    if (context.metadata?.todo) {
      this.todoStore = [...(context.metadata.todo as any).todoStore];
      this.todoStepsSinceLastWrite = (context.metadata.todo as any).stepsSinceLastWrite;
      this.todoStepsSinceLastReminder = (context.metadata.todo as any).stepsSinceLastReminder;
    }
  }

  /**
   * Get current todos.
   */
  getTodos(): TodoItem[] {
    return [...this.todoStore];
  }

  /**
   * Compress messages if over token limit.
   */
  async compressIfNeeded(context: AgentContext): Promise<Message[]> {
    const tokenLimit = context.config.tokenLimit;
    const totalTokens = countTotalTokens(context.messages);
    if (totalTokens > tokenLimit) {
      const compressed = await this.compressionStrategy.compress(context, tokenLimit);
      return compressed;
    }
    return context.messages;
  }

  /**
   * Clear all messages (keeps default system prompt if exists).
   */
  clear(): void {
    this.messages = [];
    this.todoStore = [];
    this.todoStepsSinceLastWrite = Infinity;
    this.todoStepsSinceLastReminder = Infinity;
    if (this.defaultSystemPrompt) {
      this.messages.push({
        role: 'system',
        content: this.defaultSystemPrompt,
      });
    }
  }

  getTokenLimit(): number {
    return this.tokenLimit;
  }

  /**
   * Get the current todo tracking state for TUI display.
   */
  getTodoState(): { todos: TodoItem[]; stepsSinceLastWrite: number; stepsSinceLastReminder: number } {
    return {
      todos: [...this.todoStore],
      stepsSinceLastWrite: this.todoStepsSinceLastWrite,
      stepsSinceLastReminder: this.todoStepsSinceLastReminder,
    };
  }

  /**
   * Update the todo tracking state after tool execution.
   */
  setTodoState(state: { todos: TodoItem[]; stepsSinceLastWrite: number; stepsSinceLastReminder: number }): void {
    this.todoStore = [...state.todos];
    this.todoStepsSinceLastWrite = state.stepsSinceLastWrite;
    this.todoStepsSinceLastReminder = state.stepsSinceLastReminder;
  }

  /**
   * Replace all messages (used after compression).
   */
  setMessages(messages: Message[]): void {
    // Keep system messages separate to maintain the default system prompt
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    this.messages = [...systemMessages, ...nonSystemMessages];
  }
}
