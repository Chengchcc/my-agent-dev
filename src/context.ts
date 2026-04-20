import { countTokens } from '@anthropic-ai/tokenizer';
import type { AgentContext, AgentConfig, CompressionStrategy, Message } from './types';

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

    // Remove oldest messages until we're under the limit or empty
    while (countTotalTokens(messages) > tokenLimit && messages.length > 0) {
      messages.shift();
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

  constructor(options: {
    tokenLimit: number;
    compressionStrategy?: CompressionStrategy;
    defaultSystemPrompt?: string;
  }) {
    this.tokenLimit = options.tokenLimit;
    this.compressionStrategy = options.compressionStrategy ?? new TrimOldestStrategy();
    this.messages = [];
    this.defaultSystemPrompt = options.defaultSystemPrompt;

    if (this.defaultSystemPrompt) {
      this.messages.push({
        role: 'system',
        content: this.defaultSystemPrompt,
      });
    }
  }

  /**
   * Add a message to the context.
   */
  addMessage(message: Message): void {
    this.messages.push(message);
  }

  /**
   * Get current messages.
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Get AgentContext for passing through pipeline.
   */
  getContext(config: AgentConfig): AgentContext {
    return {
      messages: [...this.messages],
      config,
      metadata: {},
      systemPrompt: this.defaultSystemPrompt,
    };
  }

  /**
   * Compress messages if over token limit.
   */
  async compressIfNeeded(context: AgentContext): Promise<Message[]> {
    const tokenLimit = context.config.tokenLimit;
    const totalTokens = countTotalTokens(context.messages);
    if (totalTokens > tokenLimit) {
      const compressed = await this.compressionStrategy.compress(context, tokenLimit);
      this.messages = compressed;
      return compressed;
    }
    return context.messages;
  }

  /**
   * Clear all messages (keeps default system prompt if exists).
   */
  clear(): void {
    this.messages = [];
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
}
