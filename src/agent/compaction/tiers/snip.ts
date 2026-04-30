import type { Message } from '../../../types';
import type { CompactionResult, CompactionThresholds } from '../types';
import { CompactionTier } from '../types';

const MIN_LINES_FOR_SNIP = 50;
const SNIP_HEAD_LINES = 40;
const SNIP_TAIL_LINES = 10;
const CHARS_PER_TOKEN_ESTIMATE = 4;

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
      if (lines.length <= MIN_LINES_FOR_SNIP) return msg; // Not worth snipping

      // Keep first N lines and last N lines
      const headLines = lines.slice(0, SNIP_HEAD_LINES);
      const tailLines = lines.slice(-SNIP_TAIL_LINES);
      const snippedCount = lines.length - MIN_LINES_FOR_SNIP;
      const estimatedTokens = Math.ceil(msg.content.length / CHARS_PER_TOKEN_ESTIMATE);

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

    const result: CompactionResult = {
      messages: resultMessages,
      tier: CompactionTier.Snip,
      tokensBefore, // Caller fills these
      tokensAfter,
      needsContinuation: snipCount > 0,
      level: snipCount > 0 ? 'snip' : 'none',
      compacted: snipCount > 0,
    };
    if (snipCount > 0) {
      result.summary = `Sniped ${snipCount} large tool outputs`;
    }
    return result;
  }
}
