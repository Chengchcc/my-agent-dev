import { describe, it, expect, spyOn } from 'bun:test';
import type { AgentContext, Message } from '../../src/types';
import { TieredCompactionManager } from '../../src/agent/compaction/compaction-manager';
import { TokenBudgetCalculator } from '../../src/agent/compaction/budget';
import { DEFAULT_COMPACTION_THRESHOLDS, DEFAULT_COMPACTION_CONFIG } from '../../src/agent/compaction/types';
import type { CompactionThresholds, CompactionConfig, TokenBudget } from '../../src/agent/compaction/types';

function makeToolMessage(content: string, toolCallId = 'tc_1'): Message {
  return { role: 'tool', content, tool_call_id: toolCallId, name: 'read' };
}

function makeAssistantWithToolCalls(toolIds: string[] = ['tc_1']): Message {
  return {
    role: 'assistant',
    content: 'Let me read that file.',
    tool_calls: toolIds.map(id => ({ id, name: 'read', arguments: { file_path: '/tmp/test.txt' } })),
  };
}

function makeUserMessage(content: string): Message {
  return { role: 'user', content };
}

function makeSystemMessage(content: string): Message {
  return { role: 'system', content };
}

function makeContext(messages: Message[]): AgentContext {
  return {
    messages,
    systemPrompt: 'You are a helpful assistant.',
    config: { tokenLimit: 180000 },
    provider: { getModelName: () => 'mock' } as AgentContext['provider'],
  };
}

const thresholds: CompactionThresholds = { ...DEFAULT_COMPACTION_THRESHOLDS };
const config: CompactionConfig = {
  ...DEFAULT_COMPACTION_CONFIG,
  thresholds,
  summaryProvider: undefined,
  enabledTiers: {
    snip: true,
    autoCompact: false, // Disabled to avoid needing a mock LLM provider
    reactiveRecovery: true,
    collapse: true,
  },
};

/** Create a TokenBudget with a controlled usageRatio */
function mockBudget(overrides: Partial<TokenBudget>): TokenBudget {
  return {
    modelLimit: 180000,
    maxOutputTokens: 4096,
    compactionBuffer: 2048,
    effectiveLimit: 180000 - 4096 - 2048,
    currentUsage: 1000,
    usageRatio: 0.50,
    ...overrides,
  };
}

describe('TieredCompactionManager - tier selection', () => {
  it('should return no compaction when usage ratio is below snip threshold', async () => {
    const budgetCalc = new TokenBudgetCalculator(180000, 4096, 2048);
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.50 }));

    const manager = new TieredCompactionManager(budgetCalc, config);
    const ctx = makeContext([makeUserMessage('hello')]);

    const result = await manager.compressWithResult(ctx, 180000);

    expect(result.tier).toBe(0);
    expect(result.compacted).toBe(false);
  });

  it('should trigger snip (Tier 1) when usage ratio is 60%-75%', async () => {
    const budgetCalc = new TokenBudgetCalculator(180000, 4096, 2048);
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.65 }));
    // countMessages needs to return a lower value so snip appears sufficient
    spyOn(budgetCalc, 'countMessages').mockReturnValue(100000);

    const manager = new TieredCompactionManager(budgetCalc, config);

    const largeOutput = Array(60).fill('x'.repeat(200)).join('\n'); // > 50 lines, > 8000 chars
    const ctx = makeContext([
      // Candidates for snipping (older messages, outside preserveRecentTurns=4)
      makeUserMessage('read a big file'),
      makeAssistantWithToolCalls(['tc_1']),
      makeToolMessage(largeOutput, 'tc_1'),
      // Preserved recent messages (last 4)
      makeUserMessage('follow-up question'),
      makeAssistantWithToolCalls(['tc_2']),
      makeToolMessage('short result', 'tc_2'),
      makeUserMessage('current turn'),
    ]);

    const result = await manager.compressWithResult(ctx, 180000);

    expect(result.tier).toBe(1);
    expect(result.level).toBe('snip');
    expect(result.compacted).toBe(true);
  });

  it('should trigger collapse (Tier 4) when usage ratio exceeds collapse threshold', async () => {
    const budgetCalc = new TokenBudgetCalculator(180000, 4096, 2048);
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.92 }));
    spyOn(budgetCalc, 'countMessages').mockReturnValue(50000);

    const manager = new TieredCompactionManager(budgetCalc, config);

    const ctx = makeContext([
      makeUserMessage('current turn'),
      makeAssistantWithToolCalls(),
      makeToolMessage('some output'),
    ]);

    const result = await manager.compressWithResult(ctx, 180000);

    expect(result.tier).toBe(4);
    expect(result.needsContinuation).toBe(true);
  });

  it('should skip disabled tiers and fall through to next', async () => {
    const budgetCalc = new TokenBudgetCalculator(180000, 4096, 2048);
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.65 }));
    spyOn(budgetCalc, 'countMessages').mockReturnValue(100000);

    // Disable snip — should fall through to next available tier
    const noSnipConfig: CompactionConfig = {
      ...config,
      thresholds,
      enabledTiers: { snip: false, autoCompact: false, reactiveRecovery: true, collapse: true },
    };
    const manager = new TieredCompactionManager(budgetCalc, noSnipConfig);

    const largeOutput = 'x'.repeat(16000);
    const ctx = makeContext([
      makeUserMessage('read a big file'),
      makeAssistantWithToolCalls(),
      makeToolMessage(largeOutput),
      makeUserMessage('analyze it'),
    ]);

    const result = await manager.compressWithResult(ctx, 180000);

    // With snip disabled, falls through directly to collapse (since auto-compact is also disabled)
    expect(result.tier).toBe(4);
  });
});

describe('TieredCompactionManager - collapse resume behavior', () => {
  it('should preserve tool_use/tool_result pairing in collapsed context', async () => {
    const budgetCalc = new TokenBudgetCalculator(180000, 4096, 2048);
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.92 }));
    spyOn(budgetCalc, 'countMessages').mockReturnValue(30000);

    const collapseOnlyConfig: CompactionConfig = {
      ...DEFAULT_COMPACTION_CONFIG,
      thresholds,
      summaryProvider: undefined,
      enabledTiers: { snip: false, autoCompact: false, reactiveRecovery: true, collapse: true },
    };
    const manager = new TieredCompactionManager(budgetCalc, collapseOnlyConfig);

    const messages: Message[] = [
      makeSystemMessage('You are a helpful assistant.'),
      makeUserMessage('first request'),
      makeAssistantWithToolCalls(['tc_a']),
      makeToolMessage('output a '.repeat(50), 'tc_a'),
      makeUserMessage('second request - check two files'),
      makeAssistantWithToolCalls(['tc_b', 'tc_c']),
      makeToolMessage('content b '.repeat(50), 'tc_b'),
      makeToolMessage('content c '.repeat(50), 'tc_c'),
      makeUserMessage('current turn'),
    ];

    const ctx = makeContext(messages);
    const result = await manager.compressWithResult(ctx, 180000);

    // System messages preserved
    const systemMsgs = result.messages.filter((m: Message) => m.role === 'system');
    expect(systemMsgs.length).toBeGreaterThanOrEqual(1);

    // No dangling assistant with tool_calls but missing all tool_results
    for (let i = 0; i < result.messages.length; i++) {
      const msg = result.messages[i];
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const toolCallIds = new Set(msg.tool_calls.map((tc: { id: string }) => tc.id));
        for (let j = i + 1; j < result.messages.length && toolCallIds.size > 0; j++) {
          const next = result.messages[j];
          if (next.role === 'tool' && next.tool_call_id && toolCallIds.has(next.tool_call_id)) {
            toolCallIds.delete(next.tool_call_id);
          }
        }
        expect(toolCallIds.size).toBe(0);
      }
    }
  });

  it('should set needsContinuation with continuation message when collapse triggers', async () => {
    const budgetCalc = new TokenBudgetCalculator(180000, 4096, 2048);
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.92 }));
    spyOn(budgetCalc, 'countMessages').mockReturnValue(25000);

    const collapseOnlyConfig: CompactionConfig = {
      ...DEFAULT_COMPACTION_CONFIG,
      thresholds,
      summaryProvider: undefined,
      enabledTiers: { snip: false, autoCompact: false, reactiveRecovery: true, collapse: true },
    };
    const manager = new TieredCompactionManager(budgetCalc, collapseOnlyConfig);

    const ctx = makeContext([
      makeSystemMessage('You are a helpful assistant.'),
      makeUserMessage('old request'),
      makeAssistantWithToolCalls(['tc_x']),
      makeToolMessage('past output '.repeat(30), 'tc_x'),
      makeUserMessage('latest request'),
    ]);

    const result = await manager.compressWithResult(ctx, 180000);

    expect(result.tier).toBe(4);
    expect(result.needsContinuation).toBe(true);

    const hasContinuation = result.messages.some(
      (m: Message) =>
        m.role === 'user' && m.content?.includes('Emergency Context Collapse')
    );
    expect(hasContinuation).toBe(true);
  });

  it('should produce messages that form a valid context for the next API call', async () => {
    const budgetCalc = new TokenBudgetCalculator(180000, 4096, 2048);
    spyOn(budgetCalc, 'calculate').mockReturnValue(mockBudget({ usageRatio: 0.92 }));
    spyOn(budgetCalc, 'countMessages').mockReturnValue(20000);

    const collapseOnlyConfig: CompactionConfig = {
      ...DEFAULT_COMPACTION_CONFIG,
      thresholds,
      summaryProvider: undefined,
      enabledTiers: { snip: false, autoCompact: false, reactiveRecovery: true, collapse: true },
    };
    const manager = new TieredCompactionManager(budgetCalc, collapseOnlyConfig);

    const ctx = makeContext([
      makeSystemMessage('You are a helpful assistant.'),
      makeUserMessage('previous work'),
      makeAssistantWithToolCalls(['tc_old']),
      makeToolMessage('old result '.repeat(20), 'tc_old'),
      makeUserMessage('continue working on this'),
    ]);

    const result = await manager.compressWithResult(ctx, 180000);

    // The collapsed result should be a valid message sequence:
    // [system, ..., continuation_msg, ...recent_msgs]
    expect(result.messages.length).toBeGreaterThan(0);

    // Should start with system message
    expect(result.messages[0].role).toBe('system');

    // Should contain a continuation message (user role with notice)
    const userMsgs = result.messages.filter((m: Message) => m.role === 'user');
    expect(userMsgs.length).toBeGreaterThan(0);
  });
});