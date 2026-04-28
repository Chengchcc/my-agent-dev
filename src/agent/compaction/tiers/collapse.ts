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

    // Get non-system messages for pairing analysis
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    // Keep the most recent messages, ensuring tool_use/tool_result pairing integrity
    // Start with last 2 messages, expand if needed to complete pairs
    let keepCount = 2;
    while (keepCount < nonSystemMessages.length) {
      const candidate = nonSystemMessages[nonSystemMessages.length - keepCount];
      if (!candidate) break;

      // If we hit a 'tool' message, keep going until we find its parent assistant message
      if (candidate.role === 'tool' && candidate.tool_call_id) {
        keepCount++;
      } else {
        break;
      }
    }

    // Also check if the first kept message is an assistant with tool_calls
    // If so, we need to ensure we have all matching tool_results
    const firstKeptIndex = nonSystemMessages.length - keepCount;
    const firstKept = nonSystemMessages[firstKeptIndex];
    if (firstKept && firstKept.role === 'assistant' && firstKept.tool_calls && firstKept.tool_calls.length > 0) {
      const toolCallIds = new Set(firstKept.tool_calls.map(tc => tc.id));
      // Look ahead for all matching tool_results
      for (let i = firstKeptIndex + 1; i < nonSystemMessages.length && toolCallIds.size > 0; i++) {
        const msg = nonSystemMessages[i];
        if (msg && msg.role === 'tool' && msg.tool_call_id && toolCallIds.has(msg.tool_call_id)) {
          toolCallIds.delete(msg.tool_call_id);
        }
      }
      // If we're missing tool_results for this assistant's tool_calls,
      // drop the assistant message entirely to avoid dangling tool_use
      // (which would cause Anthropic API to reject the request)
      if (toolCallIds.size > 0) {
        keepCount--;
      }
    }

    const recentMessages = keepCount > 0
      ? nonSystemMessages.slice(-keepCount)
      : [];

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
      ...recentMessages,
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
