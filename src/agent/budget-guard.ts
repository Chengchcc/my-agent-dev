import type { ToolCall } from '../types';

export interface BudgetGuardConfig {
  /** Threshold (ratio of remaining to total) below which delegation can trigger */
  delegateThreshold: number;
  /** Threshold (ratio of remaining to total) below which we compact first */
  compactThreshold: number;
  /** If total estimated output exceeds this fraction of remaining budget, trigger */
  batchOutputRatio: number;
  /** Minimum number of read calls in batch to trigger */
  minReadCallsForBatch: number;
  enabled: boolean;
}

export const BUDGET_ACTIONS = ['proceed', 'delegate-to-sub-agent', 'compact-first'] as const;
export type BudgetAction = (typeof BUDGET_ACTIONS)[number];

export interface BudgetCheckResult {
  action: BudgetAction;
  reason?: string;
  delegatedTask?: string;
}

export const DEFAULT_BUDGET_GUARD_CONFIG: BudgetGuardConfig = {
  delegateThreshold: 0.30,
  compactThreshold: 0.15,
  batchOutputRatio: 0.60,
  minReadCallsForBatch: 3,
  enabled: true,
};

/** Estimated token output for each tool type. */
const TOOL_OUTPUT_ESTIMATES = {
  read: {
    baseOverhead: 100,
    defaultUnknown: 3000,
    charsPerToken: 4,
    tokensPerLine: 80,
  },
  grep: 3000,
  glob: 1000,
  ls: 500,
  bash: {
    cat: 5000,
    find: 3000,
    trivial: 100,
    general: 2000,
  },
  textEditor: 1500,
  memoryTool: 1000,
  subAgent: 1500,
  default: 1000,
} as const;

/**
 * Estimate the number of tokens a tool output will produce.
 */
export function estimateToolOutput(toolCall: ToolCall): number {
  const name = toolCall.name;

  switch (name) {
    case 'read': {
      const limit = typeof toolCall.arguments.limit === 'number' ? toolCall.arguments.limit : 0;
      if (limit > 0) {
        return Math.ceil((limit * TOOL_OUTPUT_ESTIMATES.read.tokensPerLine) / TOOL_OUTPUT_ESTIMATES.read.charsPerToken) + TOOL_OUTPUT_ESTIMATES.read.baseOverhead;
      }
      // Unknown file size — use conservative estimate (no statSync to avoid blocking)
      return TOOL_OUTPUT_ESTIMATES.read.defaultUnknown;
    }

    case 'grep':
      return TOOL_OUTPUT_ESTIMATES.grep;

    case 'glob':
      return TOOL_OUTPUT_ESTIMATES.glob;

    case 'ls':
      return TOOL_OUTPUT_ESTIMATES.ls;

    case 'bash': {
      const command = (toolCall.arguments.command as string || '').toLowerCase();
      if (command.includes('cat ') || command.includes('less ') || command.includes('head ') || command.includes('tail ')) {
        return TOOL_OUTPUT_ESTIMATES.bash.cat;
      }
      if (command.includes('find ') || command.includes('grep ')) {
        return TOOL_OUTPUT_ESTIMATES.bash.find;
      }
      if (command.includes('wc ') || command.includes('echo ') || command.includes('pwd ')) {
        return TOOL_OUTPUT_ESTIMATES.bash.trivial;
      }
      return TOOL_OUTPUT_ESTIMATES.bash.general;
    }

    case 'text-editor':
      return TOOL_OUTPUT_ESTIMATES.textEditor;

    case 'memory':
      return TOOL_OUTPUT_ESTIMATES.memoryTool;

    case 'sub_agent':
      return TOOL_OUTPUT_ESTIMATES.subAgent;

    default:
      return TOOL_OUTPUT_ESTIMATES.default;
  }
}

/**
 * Check if a single tool call fits within remaining budget.
 */
export function checkToolBudget(
  toolCall: ToolCall,
  remainingTokens: number,
  totalLimit: number,
  config: Partial<BudgetGuardConfig> = {},
): BudgetCheckResult {
  const fullConfig: BudgetGuardConfig = { ...DEFAULT_BUDGET_GUARD_CONFIG, ...config };

  if (!fullConfig.enabled) {
    return { action: 'proceed' };
  }

  const estimated = estimateToolOutput(toolCall);
  const remainingRatio = remainingTokens / totalLimit;

  // Rule 1: Below compact threshold - always compact first
  if (remainingRatio < fullConfig.compactThreshold) {
    return {
      action: 'compact-first',
      reason: `Context is at ${((1 - remainingRatio) * 100).toFixed(0)}% capacity (${remainingTokens} tokens remaining). Compacting before tool execution.`,
    };
  }

  // Rule 2: Below delegate threshold AND tool is big - delegate
  if (remainingRatio < fullConfig.delegateThreshold && estimated > remainingTokens * 0.5) {
    const task = buildDelegatedTask(toolCall);
    return {
      action: 'delegate-to-sub-agent',
      reason: `Remaining budget ${remainingTokens} tokens (${(remainingRatio * 100).toFixed(0)}%), but '${toolCall.name}' estimated ~${estimated} tokens output. Delegating to sub-agent to preserve main context.`,
      delegatedTask: task,
    };
  }

  return { action: 'proceed' };
}

/**
 * Check if a batch of tool calls fits within remaining budget.
 */
export function checkBatchBudget(
  toolCalls: ToolCall[],
  remainingTokens: number,
  totalLimit: number,
  config: Partial<BudgetGuardConfig> = {},
): BudgetCheckResult {
  const fullConfig: BudgetGuardConfig = { ...DEFAULT_BUDGET_GUARD_CONFIG, ...config };

  if (!fullConfig.enabled) {
    return { action: 'proceed' };
  }

  const remainingRatio = remainingTokens / totalLimit;

  // Check for batch of reads
  const readCalls = toolCalls.filter(tc => tc.name === 'read');
  const searchCalls = toolCalls.filter(tc => ['grep', 'glob'].includes(tc.name));

  const totalEstimated = toolCalls.reduce(
    (sum, tc) => sum + estimateToolOutput(tc),
    0
  );

  // Rule 1: Below compact threshold - compact first
  if (remainingRatio < fullConfig.compactThreshold) {
    return {
      action: 'compact-first',
      reason: `Context is at ${((1 - remainingRatio) * 100).toFixed(0)}% capacity. Compacting before batch execution.`,
    };
  }

  // Rule 2: Multiple reads that exceed budget
  if (readCalls.length >= fullConfig.minReadCallsForBatch && totalEstimated > remainingTokens * fullConfig.batchOutputRatio) {
    const task = buildBatchDelegatedTask(toolCalls);
    return {
      action: 'delegate-to-sub-agent',
      reason: `Batch of ${readCalls.length} file reads estimated ~${totalEstimated} tokens, exceeding ${(fullConfig.batchOutputRatio * 100).toFixed(0)}% of remaining ${remainingTokens} tokens. Delegating to sub-agent.`,
      delegatedTask: task,
    };
  }

  // Rule 3: Search operations with low budget
  if (searchCalls.length > 0 && remainingRatio < fullConfig.delegateThreshold) {
    const task = buildBatchDelegatedTask(toolCalls);
    return {
      action: 'delegate-to-sub-agent',
      reason: `Search operations with only ${(remainingRatio * 100).toFixed(0)}% budget remaining. Delegating to sub-agent.`,
      delegatedTask: task,
    };
  }

  return { action: 'proceed' };
}

/**
 * Build a delegated task description for sub-agent from a single tool call.
 */
export function buildDelegatedTask(toolCall: ToolCall): string {
  switch (toolCall.name) {
    case 'read':
      return `Read the file at \`${toolCall.arguments.path}\` and provide a concise summary of its contents. Include:
- Overall structure and purpose
- Key exports, functions, or classes
- Notable patterns or implementation details
Keep the summary concise - the main agent only needs key information to continue working.`;

    case 'grep': {
      const pattern = toolCall.arguments.pattern as string;
      const path = toolCall.arguments.path as string;
      return `Search for pattern \`${pattern}\` ${path ? `in \`${path}\`` : 'across the project'}, and summarize the findings. Include:
- Number of matches
- Which files contain matches
- Key context around the most important matches
Do not return the full raw output - just a concise summary.`;
    }

    case 'glob': {
      const pattern = toolCall.arguments.pattern as string;
      return `Find files matching pattern \`${pattern}\` and list them with a brief note on what each file contains. Keep it concise.`;
    }

    case 'bash': {
      const command = toolCall.arguments.command as string;
      return `Execute this command:

\`\`\`
${command}
\`\`\`

Provide a concise summary of the output. Include key results, any errors, and actionable information. Do not return the raw output unless it's very short.`;
    }

    default:
      return `Execute the tool '${toolCall.name}' with these arguments:

${JSON.stringify(toolCall.arguments, null, 2)}

Provide a concise summary of the result. Only the key, actionable information is needed for the main agent to continue.`;
  }
}

/**
 * Build a delegated task description for sub-agent for multiple tool calls.
 */
export function buildBatchDelegatedTask(toolCalls: ToolCall[]): string {
  const steps = toolCalls.map((tc, i) => {
    return `${i + 1}. **${tc.name}**: ${JSON.stringify(tc.arguments)}`;
  }).join('\n');

  return `Execute the following operations and provide a unified summary of all results:

${steps}

For each step:
- What was found or done
- Key information the main agent needs to continue
- Any errors that occurred

Keep the summary concise - we're preserving context space in the main conversation. Only include actionable information, not raw output.`;
}
