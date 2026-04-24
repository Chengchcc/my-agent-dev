import { nanoid } from 'nanoid';
import { countTokens } from '@anthropic-ai/tokenizer';
import type { AgentContext, AgentConfig, CompressionStrategy, Message, ToolCall } from '../types';
import type { TodoItem } from '../todos/types';
import type { CompactionResult } from './compaction/types';
import { getSettingsSync } from '../config';
import { defaultSettings } from '../config/defaults';

export interface ContextManagerConfig {
  tokenLimit?: number;
  compressionStrategy?: CompressionStrategy;
  defaultSystemPrompt?: string;
}

/**
 * Count total tokens in an array of messages.
 */
function countTotalTokens(messages: Message[], systemPrompt?: string): number {
  let total = systemPrompt ? countTokens(systemPrompt) : 0;
  for (const msg of messages) {
    if (msg.content) {
      total += countTokens(msg.content);
    }
    if (msg.tool_calls) {
      total += countTokens(JSON.stringify(msg.tool_calls));
    }
    // 4 tokens overhead per message for role/metadata
    total += 4;
  }
  return total;
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
  private lastKnownPromptTokens: number = 0;
  private accumulatedOutputTokens: number = 0;

  constructor(config: ContextManagerConfig = {}) {
    let tokenLimit;
    try {
      const settings = getSettingsSync();
      tokenLimit = config.tokenLimit ?? settings.context.tokenLimit;
    } catch {
      tokenLimit = config.tokenLimit ?? defaultSettings.context.tokenLimit;
    }
    this.tokenLimit = tokenLimit;
    this.compressionStrategy = config.compressionStrategy ?? new TrimOldestStrategy();
    this.messages = [];
    this.defaultSystemPrompt = config.defaultSystemPrompt;
    this.currentSystemPrompt = config.defaultSystemPrompt;

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
  async compressIfNeeded(context: AgentContext): Promise<CompactionResult> {
    const tokenLimit = context.config.tokenLimit;
    // Reserve headroom for output and compaction prompt
    const effectiveLimit = tokenLimit - 6000;
    const currentTokens = this.getLastKnownPromptTokens();

    if (currentTokens > effectiveLimit) {
      // Check if compression strategy supports CompactionResult interface
      if ('compressWithResult' in this.compressionStrategy && typeof (this.compressionStrategy as any).compressWithResult === 'function') {
        return (this.compressionStrategy as any).compressWithResult(context, effectiveLimit);
      }
      // Fallback for legacy compression strategies
      const compressed = await this.compressionStrategy.compress(context, effectiveLimit);
      return {
        messages: compressed,
        level: 'none' as const,
        compacted: compressed.length < context.messages.length,
        tokensBefore: currentTokens,
        tokensAfter: countTotalTokens(compressed, context.systemPrompt),
      };
    }
    return {
      messages: context.messages,
      level: 'none' as const,
      compacted: false,
      tokensBefore: currentTokens,
      tokensAfter: currentTokens,
    };
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

  /**
   * Update token counting with accurate usage data from API response.
   */
  updateTokenUsage(usage: { prompt_tokens: number; completion_tokens: number }): void {
    this.lastKnownPromptTokens = usage.prompt_tokens;
    this.accumulatedOutputTokens += usage.completion_tokens;
  }

  /**
   * Get current context usage ratio (0-1).
   */
  getUsageRatio(): number {
    if (this.lastKnownPromptTokens <= 0) {
      // Fallback to local estimation if no API data yet
      const messages = this.getMessages();
      const estimated = countTotalTokens(messages, this.currentSystemPrompt);
      return estimated / this.tokenLimit;
    }
    return this.lastKnownPromptTokens / this.tokenLimit;
  }

  /**
   * Get remaining token budget for new content.
   */
  getRemainingBudget(): number {
    if (this.lastKnownPromptTokens <= 0) {
      const messages = this.getMessages();
      const estimated = countTotalTokens(messages, this.currentSystemPrompt);
      return this.tokenLimit - estimated;
    }
    return this.tokenLimit - this.lastKnownPromptTokens;
  }

  /**
   * Get the last known prompt tokens from API.
   */
  getLastKnownPromptTokens(): number {
    if (this.lastKnownPromptTokens <= 0) {
      const messages = this.getMessages();
      return countTotalTokens(messages, this.currentSystemPrompt);
    }
    return this.lastKnownPromptTokens;
  }

  /**
   * Force compaction with optional focus hint.
   */
  async forceCompact(focusHint?: string): Promise<CompactionResult> {
    const context = this.getContext({
      tokenLimit: this.tokenLimit,
      defaultSystemPrompt: this.defaultSystemPrompt,
    });
    if (focusHint && context.systemPrompt) {
      context.systemPrompt = `${context.systemPrompt}\n\nFocus hint: ${focusHint}`;
    }
    const totalTokens = this.getLastKnownPromptTokens();
    const effectiveLimit = this.tokenLimit - 6000; // Reserve for output + compaction prompt

    if (totalTokens > effectiveLimit && this.compressionStrategy) {
      // Type assertion: if using TieredCompaction, it returns CompactionResult
      if ('compressWithResult' in this.compressionStrategy && typeof (this.compressionStrategy as any).compressWithResult === 'function') {
        return (this.compressionStrategy as any).compressWithResult(context, effectiveLimit);
      }
      // Fallback for older strategies
      const messages = await this.compressionStrategy.compress(context, effectiveLimit);
      return {
        messages,
        level: 'unknown' as const,
        compacted: messages.length < context.messages.length,
        tokensBefore: totalTokens,
        tokensAfter: countTotalTokens(messages, context.systemPrompt),
      };
    }
    return {
      messages: context.messages,
      level: 'none' as const,
      compacted: false,
      tokensBefore: totalTokens,
      tokensAfter: totalTokens,
    };
  }

  /**
   * Replace tool_calls in the last assistant message.
   * Used when budget guard replaces tool calls with sub-agent delegation.
   */
  replaceLastAssistantToolCalls(toolCalls: ToolCall[]): void {
    const messages = [...this.messages];
    // Find the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        messages[i] = {
          ...messages[i],
          tool_calls: toolCalls,
        };
        this.messages = messages;
        return;
      }
    }
  }
}
