import { countTokens } from '@anthropic-ai/tokenizer';
import type { AgentContext, Message } from '../../types';
import type { TokenBudget } from './types';

/**
 * Calculate accurate token budget with headroom reservation.
 * Tier 0: Provides the foundation for all compression decisions.
 *
 * Fixes existing issues:
 * - Null-safe counting for assistant messages with only tool_calls
 * - Properly accounts for tool_calls JSON (previously often uncounted)
 * - Includes system prompt in token count
 * - Adds overhead for message metadata (~20 tokens per message)
 * - Reserves headroom for model output and compaction itself
 */
export class TokenBudgetCalculator {
  constructor(
    private modelLimit: number,
    private maxOutputTokens: number,
    private compactionBuffer: number = 2048,
  ) {}

  /**
   * Calculate current token budget with headroom reservation.
   */
  calculate(context: AgentContext): TokenBudget {
    const effectiveLimit = this.modelLimit - this.maxOutputTokens - this.compactionBuffer;
    const currentUsage = this.countContextTokens(context);

    return {
      modelLimit: this.modelLimit,
      maxOutputTokens: this.maxOutputTokens,
      compactionBuffer: this.compactionBuffer,
      effectiveLimit,
      currentUsage,
      usageRatio: currentUsage / effectiveLimit,
    };
  }

  /**
   * Count tokens for the full context accurately.
   */
  countContextTokens(context: AgentContext): number {
    let total = 0;

    // 1. System prompt
    if (context.systemPrompt) {
      total += countTokens(context.systemPrompt);
    }

    // 2. All messages
    for (const msg of context.messages) {
      // Content - null safe (assistant can have only tool_calls)
      if (msg.content) {
        total += countTokens(msg.content);
      }
      // Tool calls JSON - often large, easily underestimated
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        total += countTokens(JSON.stringify(msg.tool_calls));
      }
      // Overhead for metadata: role, id, tool_call_id, name, etc.
      total += 20;
    }

    return total;
  }

  /**
   * Count tokens for just a message array.
   * Useful after compression to get the new count.
   */
  countMessages(messages: Message[], systemPrompt?: string): number {
    let total = systemPrompt ? countTokens(systemPrompt) : 0;

    for (const msg of messages) {
      if (msg.content) {
        total += countTokens(msg.content);
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        total += countTokens(JSON.stringify(msg.tool_calls));
      }
      total += 20;
    }

    return total;
  }
}
