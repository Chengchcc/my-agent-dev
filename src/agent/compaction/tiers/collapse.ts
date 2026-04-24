import type { Message } from '../../../types';
import type { CompactionResult } from '../types';

/**
 * Tier 4 Compression: Context Collapse
 *
 * Nuclear option - preserve only the absolute essential context:
 * - All system messages (system prompt, default guidance)
 * - Any existing compaction summary messages (keep prior summaries)
 * - The last 2 messages (most recent user-assistant pair for current work)
 *
 * Adds a clear continuation message to orient the LLM.
 * This is the last resort when all other compression tiers haven't freed enough space.
 */
export class ContextCollapseStrategy {
  apply(messages: Message[]): CompactionResult {
    // Keep all system messages
    const systemMessages = messages.filter(m => m.role === 'system');

    // Keep any existing compaction summary messages
    // (detected by the "Context Compaction Notice" marker)
    const summaryMessages = messages.filter(m =>
      m.role === 'user' && m.content?.includes('Context Compaction Notice')
    );

    // Keep only the last two messages (most recent exchange)
    const lastTwo = messages.slice(-2);

    // Add continuation message
    const continuationMsg: Message = {
      role: 'user',
      content: [
        '---',
        '⚠️ **Emergency Context Collapse**',
        'The conversation context was critically full. All intermediate messages have been removed.',
        'Only the system prompt and the most recent exchange are preserved.',
        'If needed, re-read files or ask the user to clarify earlier context.',
        '---',
      ].join('\n'),
    };

    const newMessages = [
      ...systemMessages,
      ...summaryMessages,
      continuationMsg,
      ...lastTwo,
    ];

    return {
      messages: newMessages,
      tier: 4,
      tokensBefore: -1,
      tokensAfter: -1,
      summary: 'Emergency context collapse — only system prompt and last exchange preserved.',
      needsContinuation: true,
      level: 'summarize',
      compacted: true,
    };
  }
}
