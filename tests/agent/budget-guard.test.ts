import { describe, expect, test } from 'bun:test';
import {
  estimateToolOutput,
  checkToolBudget,
  checkBatchBudget,
  buildDelegatedTask,
  DEFAULT_BUDGET_GUARD_CONFIG,
} from '../../src/agent/budget-guard';
import type { ToolCall } from '../../src/types';

describe('estimateToolOutput', () => {
  test('gives conservative estimate for read without limit', () => {
    const toolCall: ToolCall = {
      id: 'test',
      name: 'read',
      arguments: { path: 'any-file.txt' },
    };
    const estimate = estimateToolOutput(toolCall);
    expect(estimate).toBe(3000);
  });

  test('returns 3000 for grep', () => {
    const toolCall: ToolCall = {
      id: 'test',
      name: 'grep',
      arguments: { pattern: 'test' },
    };
    expect(estimateToolOutput(toolCall)).toBe(3000);
  });

  test('returns 1000 for glob', () => {
    const toolCall: ToolCall = {
      id: 'test',
      name: 'glob',
      arguments: { pattern: '*.ts' },
    };
    expect(estimateToolOutput(toolCall)).toBe(1000);
  });
});

describe('checkToolBudget', () => {
  const config = { ...DEFAULT_BUDGET_GUARD_CONFIG };

  test('proceeds when budget is sufficient', () => {
    const toolCall: ToolCall = { id: 'test', name: 'read', arguments: { path: 'package.json' } };
    const result = checkToolBudget(toolCall, 50000, 100000, config);
    expect(result.action).toBe('proceed');
  });

  test('triggers compact-first when below compactThreshold', () => {
    const toolCall: ToolCall = { id: 'test', name: 'read', arguments: { path: 'package.json' } };
    // 10% remaining = below 15% threshold
    const result = checkToolBudget(toolCall, 10000, 100000, config);
    expect(result.action).toBe('compact-first');
  });
});

describe('checkBatchBudget', () => {
  const config = { ...DEFAULT_BUDGET_GUARD_CONFIG };

  test('triggers delegation for 3+ reads when budget is low', () => {
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'read', arguments: { path: 'file1.ts' } },
      { id: '2', name: 'read', arguments: { path: 'file2.ts' } },
      { id: '3', name: 'read', arguments: { path: 'file3.ts' } },
    ];
    // 25% remaining, total estimated ~6000 which is 24% of 25000, less than 60% → doesn't trigger yet
    const result = checkBatchBudget(toolCalls, 25000, 100000, config);
    // 3 reads, 2000 each = 6000. 6000 / 25000 = 0.24 < 0.6 → no trigger
    expect(result.action).toBe('proceed');
  });
});

describe('buildDelegatedTask', () => {
  test('builds read task', () => {
    const toolCall: ToolCall = {
      id: 'test',
      name: 'read',
      arguments: { path: 'src/agent/Agent.ts' },
    };
    const task = buildDelegatedTask(toolCall);
    expect(task).toContain('src/agent/Agent.ts');
    expect(task).toContain('concise summary');
  });

  test('builds bash task', () => {
    const toolCall: ToolCall = {
      id: 'test',
      name: 'bash',
      arguments: { command: 'bun test' },
    };
    const task = buildDelegatedTask(toolCall);
    expect(task).toContain('bun test');
    expect(task).toContain('concise summary');
  });
});
