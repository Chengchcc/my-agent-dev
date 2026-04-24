import type { CompressionStrategy, AgentContext, Message, Provider } from '../../types';
import { ToolOutputStrategy } from './tool-output-strategy';
import { SummarizeStrategy } from './summarize-strategy';
import { TrimOldestStrategy } from '../context';

/**
 * L4 Compression: Emergency reactive compression triggered when API returns prompt_too_long.
 * Incrementally applies stronger compression until we're under the limit.
 */
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
      let msgSum = msg.content ? msg.content.length / 4 : 0;
      if (msg.tool_calls) msgSum += JSON.stringify(msg.tool_calls).length / 4;
      return sum + msgSum + 4; // 4 tokens overhead per message
    }, 0);
    // Add system prompt if present
    if (context.systemPrompt) {
      estimated += context.systemPrompt.length / 4;
    }

    if (estimated > tokenLimit * 0.9) {
      // Still over - full summarization
      result = await this.summarizeStrategy.compress(
        { ...context, messages: result },
        tokenLimit
      );
      estimated = result.reduce((sum, msg) => {
        let msgSum = msg.content ? msg.content.length / 4 : 0;
        if (msg.tool_calls) msgSum += JSON.stringify(msg.tool_calls).length / 4;
        return sum + msgSum + 4;
      }, 0);
    }

    // If summarization still isn't enough - trim as last resort
    if (estimated > tokenLimit * 0.9) {
      result = await this.trimOldestStrategy.compress(
        { ...context, messages: result },
        tokenLimit
      );
    }

    return result;
  }
}