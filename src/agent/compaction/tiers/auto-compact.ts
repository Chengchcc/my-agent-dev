import type { AgentConfig, AgentContext, Message, Provider } from '../../../types';
import type { CompactionResult, CompactionConfig } from '../types';

const SUMMARY_MAX_CHARS = 3000;
const SUMMARY_TRIM_CHARS = 2000;
const SUMMARY_HEAD_CHARS = 500;

const SUMMARY_SYSTEM_PROMPT = `You are a context compaction assistant. Your job is to produce a structured, ` +
  `information-dense summary of a conversation segment. This summary will replace the original messages ` +
  `in the conversation context, so it MUST preserve all actionable details:\n` +
  `- Exact file paths and line numbers\n` +
  `- Function/variable names\n` +
  `- Error messages and their resolutions\n` +
  `- User preferences and constraints\n` +
  `- In-progress tasks and next steps\n\n` +
  `Output format: Use the 5-section structure requested. Be concise but complete. ` +
  `Prefer bullet points. Never omit a file path or technical identifier.`;

/**
 * Tier 2 Compression: Auto Compact
 *
 * Strategy: Use LLM (preferably a cheap/fast model) to summarize older conversation
 * while preserving the most recent N turns intact for current work.
 *
 * - Only compacts messages older than preserveRecentTurns
 * - Replaces old messages with a single structured summary
 * - Adds clear compaction boundary so LLM knows what happened
 */
export class AutoCompactStrategy {
  private provider: Provider;
  private config: CompactionConfig;

  constructor(
    provider: Provider,
    config: CompactionConfig,
  ) {
    this.provider = provider;
    this.config = config;
  }

  /**
   * Apply auto-compact summarization.
   * Preserves the last preserveCount messages unchanged.
   */
  async apply(
    context: AgentContext,
    preserveCount: number,
  ): Promise<CompactionResult> {
    // Filter out system messages - they'll be kept at the top
    const nonSystemMessages = context.messages.filter(m => m.role !== 'system');

    if (nonSystemMessages.length <= preserveCount) {
      // Nothing to compact
      return {
        messages: context.messages,
        tier: 2,
        tokensBefore: -1,
        tokensAfter: -1,
        needsContinuation: false,
        level: 'none',
        compacted: false,
      };
    }

    // Split: old to compact + recent to preserve
    const toCompact = nonSystemMessages.slice(0, -preserveCount);
    const recent = nonSystemMessages.slice(-preserveCount);

    // Generate summary via LLM
    const summary = await this.generateSummary(toCompact);

    // Format the summary as a boundary message
    const boundaryMessage = this.formatCompactionSummary(summary);

    // Reconstruct message array
    const systemMessages = context.messages.filter(m => m.role === 'system');
    const newMessages = [
      ...systemMessages,
      boundaryMessage,
      ...recent,
    ];

    // Map tier to old CompactionLevelType for backward compatibility
    const level = 'summarize';

    return {
      messages: newMessages,
      tier: 2,
      tokensBefore: -1,
      tokensAfter: -1,
      summary,
      needsContinuation: true,
      level,
      compacted: true,
    };
  }

  /**
   * Call LLM to generate the structured summary.
   */
  private async generateSummary(messages: Message[]): Promise<string> {
    const prompt = this.buildSummaryPrompt(messages);

    const config: AgentConfig = {
      tokenLimit: 200_000,
    };
    if (this.config.summaryModel) {
      config.model = this.config.summaryModel;
    }
    const summaryContext: AgentContext = {
      messages: [{ role: 'user', content: prompt }],
      config,
      metadata: {},
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
    };

    const response = await this.provider.invoke(summaryContext);
    return response.content;
  }

  /**
   * Build the summary prompt with formatted messages.
   */
  private buildSummaryPrompt(messages: Message[]): string {
    const formatted = messages.map(m => {
      const prefix = m.role === 'tool' ? `[tool:${m.name}]` : `[${m.role}]`;
      const content = m.content ?? '(tool_calls only)';
      // Truncate very long tool outputs for the summary prompt too
      const truncated = content.length > SUMMARY_MAX_CHARS
        ? content.slice(0, SUMMARY_TRIM_CHARS) + '\n...[truncated]...\n' + content.slice(-SUMMARY_HEAD_CHARS)
        : content;
      return `${prefix}\n${truncated}`;
    }).join('\n\n---\n\n');

    return `Summarize the following conversation segment. Extract these specific sections:\n\n` +
      `1. **User Goals**: What the user is trying to accomplish\n` +
      `2. **Key Decisions**: Important decisions made, approaches chosen\n` +
      `3. **Completed Work**: Files modified, tools used, results obtained\n` +
      `4. **Active State**: Anything in progress that needs continuation\n` +
      `5. **Important Context**: Technical details, constraints, user preferences mentioned\n\n` +
      `Be specific — include file paths, function names, and exact values. ` +
      `This summary will replace the original messages in context.\n\n` +
      `---\n\n${formatted}`;
  }

  /**
   * Format the final compaction summary message.
   */
  private formatCompactionSummary(summary: string): Message {
    const content = [
      '---',
      '⚠️ **Context Compaction Notice**',
      'Earlier conversation was summarized to free context space.',
      'If you need details from before this point, ask to re-read specific files.',
      '---',
      '',
      summary,
      '',
      '---',
      'Conversation continues below with full detail.',
      '---',
    ].join('\n');

    return {
      role: 'user',
      content,
    };
  }
}
