import type { CompressionStrategy, AgentContext, Message } from '../../types';
import type { CompactionResult, CompactionLevel, TieredCompactionConfig } from './types';
import { DEFAULT_TIERED_LEVELS } from './types';
import { SnipStrategy } from './snip-strategy';
import { ToolOutputStrategy } from './tool-output-strategy';
import { SummarizeStrategy } from './summarize-strategy';
import { Provider } from '../../types';

/**
 * Count tokens for estimation when we don't have accurate API usage data.
 * 1 token ≈ 4 characters.
 */
function countTokensForEstimate(messages: AgentContext['messages']): number {
  return messages.reduce((sum, msg) => {
    let total = msg.content ? msg.content.length / 4 : 0;
    if (msg.tool_calls) {
      total += JSON.stringify(msg.tool_calls).length / 4;
    }
    return total + 4; // 4 tokens overhead per message
  }, 0);
}

/**
 * Main tiered compaction scheduler.
 * Selects the highest applicable compression level based on current usage ratio.
 */
export class TieredCompaction implements CompressionStrategy {
  private readonly levels: CompactionLevel[];

  constructor(provider: Provider, config?: Partial<TieredCompactionConfig>) {
    // Initialize strategies with default levels if not provided
    this.levels = config?.levels ?? [
      { name: 'snip', triggerAt: 0.60, strategy: new SnipStrategy() },
      { name: 'tool-shrink', triggerAt: 0.75, strategy: new ToolOutputStrategy() },
      { name: 'summarize', triggerAt: 0.85, strategy: new SummarizeStrategy(provider) },
    ];

    // Sort by trigger ascending so highest trigger is last
    this.levels.sort((a, b) => a.triggerAt - b.triggerAt);
  }

  /**
   * Compression interface for backward compatibility.
   */
  async compress(context: AgentContext, tokenLimit: number): Promise<Message[]> {
    const result = await this.compressWithResult(context, tokenLimit);
    return result.messages;
  }

  /**
   * Compress and return full result with metadata.
   */
  async compressWithResult(context: AgentContext, tokenLimit: number): Promise<CompactionResult> {
    const totalTokens = countTokensForEstimate(context.messages) +
      (context.systemPrompt ? context.systemPrompt.length / 4 : 0);
    const ratio = totalTokens / tokenLimit;

    // Find the highest applicable level
    const applicableLevel = this.levels
      .filter(l => ratio >= l.triggerAt)
      .pop();

    if (!applicableLevel?.strategy) {
      return {
        messages: context.messages,
        level: 'none',
        compacted: false,
        tokensBefore: Math.round(totalTokens),
        tokensAfter: Math.round(totalTokens),
      };
    }

    const resultMessages = await applicableLevel.strategy.compress(context, tokenLimit);
    const afterTokens = countTokensForEstimate(resultMessages) +
      (context.systemPrompt ? context.systemPrompt.length / 4 : 0);

    return {
      messages: resultMessages,
      level: applicableLevel.name,
      compacted: resultMessages.length < context.messages.length || afterTokens < totalTokens,
      tokensBefore: Math.round(totalTokens),
      tokensAfter: Math.round(afterTokens),
    };
  }
}