import type { Message } from '../../../types';
import type { CompactionResult, CompactionThresholds } from '../types';

/**
 * Tier 1 Compression: Tool Output Snip
 *
 * Strategy: Truncate large tool outputs by keeping the head and tail with a placeholder.
 * - Never touches recent messages (preserves current work)
 * - Only processes role: 'tool' messages
 * - No disk IO, no LLM call - pure rule-based
 * - Preserves enough context for LLM to understand the output structure
 */
export class ToolOutputSnipStrategy {
  constructor(private config: CompactionThresholds) {}

  /**
   * Apply snip compression to messages.
   * Preserves the last preserveCount messages untouched.
   */
  apply(messages: Message[], preserveCount: number): CompactionResult {
    const preserved = messages.slice(-preserveCount);
    const candidates = messages.slice(0, -preserveCount);

    let snipCount = 0;
    let tokensBefore = 0;
    let tokensAfter = 0;

    const processed = candidates.map(msg => {
      if (msg.role !== 'tool' || !msg.content || msg.content.length < this.config.toolOutputSnipThreshold) {
        return msg;
      }

      const lines = msg.content.split('\n');
      if (lines.length <= 50) return msg; // Not worth snipping

      // Keep first 40 lines and last 10 lines
      const headLines = lines.slice(0, 40);
      const tailLines = lines.slice(-10);
      const snippedCount = lines.length - 50;
      const estimatedTokens = Math.ceil(msg.content.length / 4);

      const snipped = [
        ...headLines,
        '',
        `[... ${snippedCount} lines snipped (~${estimatedTokens} tokens) ...]`,
        `[Tool: ${msg.name ?? 'unknown'} | Original: ${lines.length} lines]`,
        '',
        ...tailLines,
      ].join('\n');

      snipCount++;
      return { ...msg, content: snipped };
    });

    const resultMessages = [...processed, ...preserved];

    return {
      messages: resultMessages,
      tier: 1 as const,
      tokensBefore, // Caller fills these
      tokensAfter,
      summary: snipCount > 0 ? `Sniped ${snipCount} large tool outputs` : undefined,
      needsContinuation: snipCount > 0,
      level: snipCount > 0 ? 'snip' : 'none',
      compacted: snipCount > 0,
    };
  }
}
