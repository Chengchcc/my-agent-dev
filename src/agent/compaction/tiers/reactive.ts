import type { Message } from '../../../types';
import type { CompactionResult } from '../types';
import { CompactionTier } from '../types';

const AGGRESSIVE_SNIP_THRESHOLD = 2000;
const RECENT_MESSAGE_BOUNDARY = 4;

/**
 * Tier 3 Compression: Reactive Recovery
 *
 * Strategy: Emergency compression triggered when API returns context_length_exceeded.
 * Does NOT call LLM (since the LLM call just failed) - uses pure rule-based compression.
 *
 * 1. First: Aggressive snipping of ALL tool outputs (including recent) to max 2000 chars
 * 2. If still over: Remove all old tool result messages (keep assistant text), fix orphaned tool_calls
 * 3. If still over: Signal that Tier 4 collapse is needed
 */
export class ReactiveRecoveryStrategy {
  /**
   * Apply reactive emergency compression.
   * @param messages Current messages
   * @param targetTokens Target token count we need to get under
   * @param countFn Function to count tokens after each step
   */
  apply(
    messages: Message[],
    targetTokens: number,
    countFn: (msgs: Message[]) => number,
  ): CompactionResult {
    let current = [...messages];

    // Phase 1: Aggressive tool output snipping - all messages, including recent
    current = this.snipAllToolOutputs(current, AGGRESSIVE_SNIP_THRESHOLD);
    const afterSnip = countFn(current);
    if (afterSnip <= targetTokens) {
      return {
        messages: current,
        tier: CompactionTier.Reactive,
        tokensBefore: -1,
        tokensAfter: afterSnip,
        needsContinuation: false,
        level: 'reactive',
        compacted: true,
      };
    }

    // Phase 2: Remove old tool results entirely, keep assistant messages
    // Keep last 4 messages always (current turn in progress)
    const recentBoundary = current.length - RECENT_MESSAGE_BOUNDARY;
    current = current.filter((msg, idx) => {
      if (idx >= recentBoundary) return true; // Always keep recent
      if (msg.role === 'tool') return false;   // Remove old tool results
      return true;
    });

    // Fix orphaned tool_calls - if the tool result is gone, we need to clean up
    current = this.fixOrphanedToolCalls(current);
    const afterRemove = countFn(current);
    if (afterRemove <= targetTokens) {
      return {
        messages: current,
        tier: CompactionTier.Reactive,
        tokensBefore: -1,
        tokensAfter: afterRemove,
        needsContinuation: false,
        level: 'reactive',
        compacted: true,
      };
    }

    // Phase 3: Still over - need Tier 4 collapse
    return {
      messages: current,
      tier: CompactionTier.Reactive,
      tokensBefore: -1,
      tokensAfter: afterRemove,
      summary: 'Reactive compression applied but still over limit',
      needsContinuation: true,
      level: 'reactive',
      compacted: true,
    };
  }

  /**
   * Aggressively snip all tool outputs that exceed maxChars.
   */
  private snipAllToolOutputs(messages: Message[], maxChars: number): Message[] {
    return messages.map(msg => {
      if (msg.role !== 'tool' || !msg.content || msg.content.length <= maxChars) {
        return msg;
      }
      const snipped = msg.content.slice(0, maxChars) +
        `\n\n[... output truncated from ${msg.content.length} to ${maxChars} chars ...]`;
      return { ...msg, content: snipped };
    });
  }

  /**
   * Fix orphaned tool_calls: if an assistant message has tool_calls whose
   * tool_result messages were removed, clean up the tool_calls array.
   * If all tool results are gone, convert tool_calls to text summary.
   */
  private fixOrphanedToolCalls(messages: Message[]): Message[] {
    const existingToolResultIds = new Set(
      messages.filter(m => m.role === 'tool' && m.tool_call_id).map(m => m.tool_call_id)
    );

    return messages.map(msg => {
      if (msg.role !== 'assistant' || !msg.tool_calls) return msg;

      // Keep only tool_calls that still have their result
      const validCalls = msg.tool_calls.filter(tc => existingToolResultIds.has(tc.id));

      if (validCalls.length === msg.tool_calls.length) return msg;

      if (validCalls.length === 0) {
        // All tool results removed - convert to text summary
        const toolSummary = msg.tool_calls.map(tc =>
          `[Previously called: ${tc.name}(${Object.keys(tc.arguments).join(', ')})]`
        ).join('\n');
        const { tool_calls: _ignored, ...msgWithoutToolCalls } = msg;
        return {
          ...msgWithoutToolCalls,
          content: (msg.content || '') + '\n' + toolSummary,
        };
      }

      return { ...msg, tool_calls: validCalls };
    });
  }
}
