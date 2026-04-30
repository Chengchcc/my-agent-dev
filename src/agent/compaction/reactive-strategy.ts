import type { CompressionStrategy, AgentContext, Message, Provider } from '../../types';
import { ToolOutputStrategy } from './tool-output-strategy';
import { SummarizeStrategy } from './summarize-strategy';
import { TrimOldestStrategy } from '../context';

/**
 * L4 Compression: Emergency reactive compression triggered when API returns prompt_too_long.
 * Incrementally applies stronger compression until we're under the limit.
 */
const CHARS_PER_TOKEN_ESTIMATE = 4;
const TOKENS_PER_MSG_OVERHEAD = 4;
const COMPRESSION_RATIO_THRESHOLD = 0.9;

export class ReactiveStrategy implements CompressionStrategy {
  private readonly aggressiveToolOutputStrategy: ToolOutputStrategy;
  private readonly summarizeStrategy: SummarizeStrategy;
  private readonly trimOldestStrategy: TrimOldestStrategy;

  constructor(provider: Provider) {
    // More aggressive than normal tool output compression - only keep 1 hot
    this.aggressiveToolOutputStrategy = new ToolOutputStrategy({ hotTailSize: 1 });
    this.summarizeStrategy = new SummarizeStrategy(provider);
    this.trimOldestStrategy = new TrimOldestStrategy();
  }

  async compress(context: AgentContext, tokenLimit: number): Promise<Message[]> {
    // First try aggressive tool output compression
    let result = await this.aggressiveToolOutputStrategy.compress(context, tokenLimit);

    // Check if we're still over - estimate tokens
    let estimated = result.reduce((sum, msg) => {
      let msgSum = msg.content ? msg.content.length / CHARS_PER_TOKEN_ESTIMATE : 0;
      if (msg.tool_calls) msgSum += JSON.stringify(msg.tool_calls).length / CHARS_PER_TOKEN_ESTIMATE;
      return sum + msgSum + TOKENS_PER_MSG_OVERHEAD; // token overhead per message
    }, 0);
    // Add system prompt if present
    if (context.systemPrompt) {
      estimated += context.systemPrompt.length / CHARS_PER_TOKEN_ESTIMATE;
    }

    if (estimated > tokenLimit * COMPRESSION_RATIO_THRESHOLD) {
      // Still over - full summarization
      result = await this.summarizeStrategy.compress(
        { ...context, messages: result },
        tokenLimit
      );
      estimated = result.reduce((sum, msg) => {
        let msgSum = msg.content ? msg.content.length / CHARS_PER_TOKEN_ESTIMATE : 0;
        if (msg.tool_calls) msgSum += JSON.stringify(msg.tool_calls).length / CHARS_PER_TOKEN_ESTIMATE;
        return sum + msgSum + TOKENS_PER_MSG_OVERHEAD;
      }, 0);
    }

    // If summarization still isn't enough - trim as last resort
    if (estimated > tokenLimit * COMPRESSION_RATIO_THRESHOLD) {
      result = await this.trimOldestStrategy.compress(
        { ...context, messages: result },
        tokenLimit
      );
    }

    return result;
  }
}