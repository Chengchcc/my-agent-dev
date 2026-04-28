import type { SlashCommand } from '../command-registry';
import type { CommandHandlerContext } from '../types';

interface AgentToolAccess {
  getToolRegistry?: () => {
    getAllDefinitions(): Array<{ name: string; description: string; parameters?: unknown }>;
  } | null;
  toolRegistry?: {
    getAllDefinitions(): Array<{ name: string; description: string; parameters?: unknown }>;
  } | null;
}

async function handleCost(ctx: CommandHandlerContext): Promise<void> {
  const { agent, onOutput } = ctx;
  const cm = agent.getContextManager();
  const currentTokens = cm.getCurrentTokens();
  const tokenLimit = agent.config.tokenLimit || 128000;
  const ratio = tokenLimit > 0 ? (currentTokens / tokenLimit * 100).toFixed(1) : '0';
  const remaining = tokenLimit - currentTokens;
  const accumulated = cm.getAccumulatedOutputTokens();

  const lines = [
    `Context tokens: ${currentTokens.toLocaleString()} / ${tokenLimit.toLocaleString()} (${ratio}%)`,
    `Remaining: ${remaining.toLocaleString()}`,
    `Accumulated output tokens: ${accumulated.toLocaleString()}`,
    `Model: ${agent.config.model || 'default'}`,
  ];
  onOutput(lines.join('\n'));
}

async function handleTools(ctx: CommandHandlerContext): Promise<void> {
  const { agent, onOutput } = ctx;
  const registry = (agent as unknown as AgentToolAccess).getToolRegistry?.()
    || (agent as unknown as AgentToolAccess).toolRegistry;
  if (!registry || typeof registry.getAllDefinitions !== 'function') {
    onOutput('Tool registry not available.');
    return;
  }

  const tools = registry.getAllDefinitions() as Array<{ name: string; description: string; parameters?: unknown }>;
  if (tools.length === 0) {
    onOutput('No tools registered.');
    return;
  }

  const lines = [`Registered tools (${tools.length}):`, ''];
  const maxLen = Math.max(...tools.map(t => t.name.length));
  for (const tool of tools) {
    const desc = tool.description.length > 80 ? tool.description.slice(0, 77) + '...' : tool.description;
    lines.push(`  ${tool.name.padEnd(maxLen + 2)} ${desc}`);
  }
  onOutput(lines.join('\n'));
}

export const costCommand: SlashCommand = {
  name: 'cost',
  description: 'Show current session token usage and cost',
  type: 'builtin',
  handler: handleCost,
};

export const toolsCommand: SlashCommand = {
  name: 'tools',
  description: 'List all registered tools',
  type: 'builtin',
  handler: handleTools,
};
