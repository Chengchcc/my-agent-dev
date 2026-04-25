import { nanoid } from 'nanoid';
import { countTokens } from '@anthropic-ai/tokenizer';
import type { AgentContext, AgentConfig, CompressionStrategy, Message, ToolCall } from '../types';
import type { TodoItem } from '../todos/types';
import type { CompactionResult } from './compaction/types';
import { getSettingsSync } from '../config';
import { defaultSettings } from '../config/defaults';

// Reserve headroom for model output and compaction prompt
const TOKEN_HEADROOM = 6000;

// Interface for compression strategies that support detailed compaction results
interface CompressionStrategyWithResult extends CompressionStrategy {
  compressWithResult(context: AgentContext, tokenLimit: number): Promise<CompactionResult>;
}

// Type guard to check if a compression strategy supports compressWithResult
function isCompressionWithResult(strategy: CompressionStrategy): strategy is CompressionStrategyWithResult {
  return 'compressWithResult' in strategy && typeof (strategy as any).compressWithResult === 'function';
}

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
    total += countSingleMessageTokens(msg);
  }
  return total;
}

/**
 * Count tokens for a single message (content + tool_calls + overhead).
 * Extracted for incremental cache updates so addMessage is O(1).
 */
function countSingleMessageTokens(msg: Message): number {
  let tokens = 4; // overhead per message for role/metadata
  if (msg.content) {
    tokens += countTokens(msg.content);
  }
  if (msg.tool_calls) {
    tokens += countTokens(JSON.stringify(msg.tool_calls));
  }
  return tokens;
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
      if (!first) break;
      if (first.role === 'assistant' && first.tool_calls && first.tool_calls.length > 0) {
        let removeCount = 1; // Start with assistant message itself
        // Remove consecutive tool result messages that match any of the tool_call_ids from this assistant
        for (let i = 1; i < messages.length && removeCount <= 1 + first.tool_calls.length; i++) {
          const msg = messages[i];
          if (!msg) break;
          if (msg.role === 'tool' && msg.tool_call_id && first.tool_calls.some(tc => tc.id === msg.tool_call_id)) {
            removeCount++;
          } else {
            break; // Stop at first non-matching message
          }
        }
        messages = messages.slice(removeCount);
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
  private _cachedEstimatedTokens: number = -1;

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
    if (config.defaultSystemPrompt) {
      this.defaultSystemPrompt = config.defaultSystemPrompt;
      this.currentSystemPrompt = config.defaultSystemPrompt;
    }

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
   * Incrementally updates the token cache instead of invalidating.
   */
  addMessage(message: Message): void {
    const msg = {
      ...message,
      id: message.id ?? nanoid(),
    };
    this.messages.push(msg);
    if (this._cachedEstimatedTokens >= 0) {
      this._cachedEstimatedTokens += countSingleMessageTokens(msg);
    }
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
  setSystemPrompt(systemPrompt: string): void {
    this._cachedEstimatedTokens = -1;
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
    const result: AgentContext = {
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
    };
    if (this.currentSystemPrompt) {
      result.systemPrompt = this.currentSystemPrompt;
    }
    return result;
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
   * Helper to get compaction result with shared fallback logic.
   */
  private async getCompactionResult(
    context: AgentContext,
    effectiveLimit: number,
    currentTokens: number,
  ): Promise<CompactionResult> {
    if (currentTokens > effectiveLimit && this.compressionStrategy) {
      if (isCompressionWithResult(this.compressionStrategy)) {
        return this.compressionStrategy.compressWithResult(context, effectiveLimit);
      }
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
   * Compress messages if over token limit.
   */
  async compressIfNeeded(context: AgentContext): Promise<CompactionResult> {
    const tokenLimit = context.config.tokenLimit;
    const effectiveLimit = tokenLimit - TOKEN_HEADROOM;
    const currentTokens = this.getLastKnownPromptTokens();

    return this.getCompactionResult(context, effectiveLimit, currentTokens);
  }

  /**
   * Clear all messages (keeps default system prompt if exists).
   */
  clear(): void {
    this._cachedEstimatedTokens = -1;
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

  /**
   * Get the token limit.
   */
  getTokenLimit(): number {
    return this.tokenLimit;
  }

  /**
   * Get accumulated output tokens from all model responses.
   */
  getAccumulatedOutputTokens(): number {
    return this.accumulatedOutputTokens;
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
    this._cachedEstimatedTokens = -1;
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
  private getEstimatedTokens(): number {
    if (this._cachedEstimatedTokens < 0) {
      const messages = this.getMessages();
      this._cachedEstimatedTokens = countTotalTokens(messages, this.currentSystemPrompt);
    }
    return this._cachedEstimatedTokens;
  }

  getUsageRatio(): number {
    if (this.lastKnownPromptTokens <= 0) {
      return this.getEstimatedTokens() / this.tokenLimit;
    }
    return this.lastKnownPromptTokens / this.tokenLimit;
  }

  /**
   * Get remaining token budget for new content.
   */
  getRemainingBudget(): number {
    if (this.lastKnownPromptTokens <= 0) {
      return this.tokenLimit - this.getEstimatedTokens();
    }
    return this.tokenLimit - this.lastKnownPromptTokens;
  }

  // Exposed for diagnostics
  get _lastKnownPromptTokens() { return this.lastKnownPromptTokens; }

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
    const agentConfig: AgentConfig = {
      tokenLimit: this.tokenLimit,
    };
    if (this.defaultSystemPrompt) {
      agentConfig.defaultSystemPrompt = this.defaultSystemPrompt;
    }
    const context = this.getContext(agentConfig);
    if (focusHint && context.systemPrompt) {
      context.systemPrompt = `${context.systemPrompt}\n\nFocus hint: ${focusHint}`;
    }
    const totalTokens = this.getLastKnownPromptTokens();
    const effectiveLimit = this.tokenLimit - TOKEN_HEADROOM; // Reserve for output + compaction prompt

    return this.getCompactionResult(context, effectiveLimit, totalTokens);
  }

  /**
   * Replace tool_calls in the last assistant message.
   * Used when budget guard replaces tool calls with sub-agent delegation.
   */
  replaceLastAssistantToolCalls(toolCalls: ToolCall[]): void {
    this._cachedEstimatedTokens = -1;
    const messages = [...this.messages];
    // Find the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.role === 'assistant') {
        messages[i] = {
          ...msg,
          tool_calls: toolCalls,
        };
        this.messages = messages;
        return;
      }
    }
  }
}
