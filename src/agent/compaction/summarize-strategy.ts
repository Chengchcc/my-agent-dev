import type { CompressionStrategy, AgentContext, Message, Provider } from '../../types';

const COMPACTION_PROMPT = `Summarize this conversation into a structured working state
that allows continuation without re-asking questions.

You MUST include these sections:

## User Intent
What the user originally asked for and any clarifications.

## Key Decisions
Technical decisions made and their rationale.

## Files Touched
Which files were read/modified and why.

## Errors & Fixes
Any errors encountered and how they were resolved.

## Current State
What has been completed so far.

## Pending Tasks
What still needs to be done, in priority order.

## Next Step
The exact next action to take when resuming.

Be concise but complete. This summary replaces the full conversation.`;

/**
 * L3 Compression: Full LLM summarization of the entire conversation.
 * Produces a structured summary with continuation prompt that replaces full history.
 */
export class SummarizeStrategy implements CompressionStrategy {
  private readonly provider: Provider;

  constructor(provider: Provider) {
    this.provider = provider;
  }

  async compress(context: AgentContext, tokenLimit: number): Promise<Message[]> {
    // Create a context for the summarization request
    const summaryRequest: Message = {
      role: 'user',
      content: COMPACTION_PROMPT,
    };

    const summaryContext: AgentContext = {
      ...context,
      messages: [...context.messages, summaryRequest],
    };

    // Ask LLM for the summary
    const response = await this.provider.invoke(summaryContext);
    const summary = response.content;

    // Create continuation message
    const continuationMessage: Message = {
      role: 'user',
      content: `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${summary}

Continue the conversation from where you left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening.`,
    };

    // Keep system messages + continuation
    const systemMessages = context.messages.filter(m => m.role === 'system');
    return [...systemMessages, continuationMessage];
  }
}