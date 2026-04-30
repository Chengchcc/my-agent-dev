import type { SlashCommand } from '../command-registry';
import type { CommandHandlerContext } from '../types';

const PERCENT_MULTIPLIER = 100;

export const compactCommand: SlashCommand = {
  name: 'compact',
  description: 'Manually compact conversation context to save tokens',
  type: 'builtin',
  handler: async (ctx: CommandHandlerContext): Promise<void> => {
    const { agent, onOutput, args } = ctx;
    const focusHint = args.trim();
    const contextManager = agent.getContextManager();
    const result = await contextManager.forceCompact(focusHint || undefined);
    agent.getContextManager().setMessages(result.messages);

    ctx.refreshMessages();

    if (!result.compacted) {
      onOutput(`Context compaction not needed - usage is ${contextManager.getUsageRatio() * PERCENT_MULTIPLIER | 0}%, compaction would not free significant space.`);
      return;
    }

    onOutput(`Context compacted (level: ${result.level}): ${result.tokensBefore} → ${result.tokensAfter} tokens (${Math.round((1 - result.tokensAfter / result.tokensBefore) * PERCENT_MULTIPLIER)}% reduction).`);
  },
};
