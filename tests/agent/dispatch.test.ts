import { describe, it, expect } from 'bun:test';
import { planExecution, type ExecutionPlan } from '../../src/agent/dispatch';
import type { ToolImplementation, ToolCall } from '../../src/types';
import type { ToolContext } from '../../src/agent/tool-dispatch/types';
import { ToolRegistry } from '../../src/agent/tool-registry';

function makeToolCall(id: string, name: string): ToolCall {
  return { id, name, arguments: {} };
}

function makeReadonlyTool(name: string): ToolImplementation {
  return {
    readonly: true,
    getDefinition() { return { name, description: '', parameters: {} }; },
    execute(_params: Record<string, unknown>, _ctx: ToolContext) { return Promise.resolve({}); },
  };
}

function makeWriteTool(name: string, conflictKey?: (input: unknown) => string | null): ToolImplementation {
  return {
    readonly: false,
    conflictKey,
    getDefinition() { return { name, description: '', parameters: {} }; },
    execute(_params: Record<string, unknown>, _ctx: ToolContext) { return Promise.resolve({}); },
  };
}

describe('planExecution', () => {
  it('groups consecutive readonly tools into one wave', () => {
    const registry = new ToolRegistry();
    registry.register(makeReadonlyTool('read'));
    registry.register(makeReadonlyTool('grep'));

    const calls: ToolCall[] = [
      makeToolCall('1', 'read'),
      makeToolCall('2', 'grep'),
      makeToolCall('3', 'read'),
    ];

    const plan = planExecution(calls, (name) => registry.get(name));
    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0]).toHaveLength(3);
  });

  it('each non-readonly tool gets its own wave (conservative)', () => {
    const registry = new ToolRegistry();
    registry.register(makeWriteTool('bash', () => 'bash:global'));
    registry.register(makeWriteTool('text_editor', (input: unknown) => `file:${(input as Record<string, unknown>).path ?? ''}`));

    const calls: ToolCall[] = [
      makeToolCall('1', 'bash'),
      makeToolCall('2', 'text_editor'),
    ];

    const plan = planExecution(calls, (name) => registry.get(name));
    expect(plan.waves).toHaveLength(2);
    expect(plan.waves[0]).toHaveLength(1);
    expect(plan.waves[1]).toHaveLength(1);
  });

  it('3 read + 1 edit + 2 read → [[r,r,r],[e],[r,r]]', () => {
    const registry = new ToolRegistry();
    registry.register(makeReadonlyTool('read'));
    registry.register(makeWriteTool('text_editor', (input: unknown) => `file:${(input as Record<string, unknown>).path ?? ''}`));

    const calls: ToolCall[] = [
      makeToolCall('1', 'read'),
      makeToolCall('2', 'read'),
      makeToolCall('3', 'read'),
      makeToolCall('4', 'text_editor'),
      makeToolCall('5', 'read'),
      makeToolCall('6', 'read'),
    ];

    const plan = planExecution(calls, (name) => registry.get(name));

    expect(plan.waves).toHaveLength(3);
    // Wave 0: three reads
    expect(plan.waves[0]).toHaveLength(3);
    expect(plan.waves[0]!.every(c => c.name === 'read')).toBe(true);
    // Wave 1: one edit
    expect(plan.waves[1]).toHaveLength(1);
    expect(plan.waves[1]![0]!.name).toBe('text_editor');
    // Wave 2: two reads
    expect(plan.waves[2]).toHaveLength(2);
    expect(plan.waves[2]!.every(c => c.name === 'read')).toBe(true);
  });

  it('empty tool calls → no waves', () => {
    const registry = new ToolRegistry();
    const plan = planExecution([], (name) => registry.get(name));
    expect(plan.waves).toHaveLength(0);
  });

  it('single readonly → one wave', () => {
    const registry = new ToolRegistry();
    registry.register(makeReadonlyTool('read'));

    const plan = planExecution([makeToolCall('1', 'read')], (name) => registry.get(name));
    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0]).toHaveLength(1);
  });

  it('single write → one wave', () => {
    const registry = new ToolRegistry();
    registry.register(makeWriteTool('bash', () => 'bash:global'));

    const plan = planExecution([makeToolCall('1', 'bash')], (name) => registry.get(name));
    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0]).toHaveLength(1);
  });

  it('write, read, write → [[w],[r],[w]]', () => {
    const registry = new ToolRegistry();
    registry.register(makeWriteTool('bash', () => 'bash:global'));
    registry.register(makeReadonlyTool('read'));

    const calls: ToolCall[] = [
      makeToolCall('1', 'bash'),
      makeToolCall('2', 'read'),
      makeToolCall('3', 'bash'),
    ];

    const plan = planExecution(calls, (name) => registry.get(name));
    expect(plan.waves).toHaveLength(3);
    expect(plan.waves[0]).toHaveLength(1);
    expect(plan.waves[0]![0]!.name).toBe('bash');
    expect(plan.waves[1]).toHaveLength(1);
    expect(plan.waves[1]![0]!.name).toBe('read');
    expect(plan.waves[2]).toHaveLength(1);
    expect(plan.waves[2]![0]!.name).toBe('bash');
  });

  it('read, write, read → [[r],[w],[r]]', () => {
    const registry = new ToolRegistry();
    registry.register(makeReadonlyTool('read'));
    registry.register(makeWriteTool('text_editor', (input: unknown) => `file:${(input as Record<string, unknown>).path ?? ''}`));

    const calls: ToolCall[] = [
      makeToolCall('1', 'read'),
      makeToolCall('2', 'text_editor'),
      makeToolCall('3', 'read'),
    ];

    const plan = planExecution(calls, (name) => registry.get(name));
    expect(plan.waves).toHaveLength(3);
    // read alone (not batched because interrupted by write)
    expect(plan.waves[0]).toHaveLength(1);
    expect(plan.waves[0]![0]!.name).toBe('read');
    // write alone
    expect(plan.waves[1]).toHaveLength(1);
    expect(plan.waves[1]![0]!.name).toBe('text_editor');
    // read alone
    expect(plan.waves[2]).toHaveLength(1);
    expect(plan.waves[2]![0]!.name).toBe('read');
  });

  it('all writes → one wave per write', () => {
    const registry = new ToolRegistry();
    registry.register(makeWriteTool('bash', () => 'bash:global'));
    registry.register(makeWriteTool('text_editor', (input: unknown) => `file:${(input as Record<string, unknown>).path ?? ''}`));
    registry.register(makeWriteTool('memory', () => 'memory:global'));

    const calls: ToolCall[] = [
      makeToolCall('1', 'bash'),
      makeToolCall('2', 'text_editor'),
      makeToolCall('3', 'memory'),
    ];

    const plan = planExecution(calls, (name) => registry.get(name));
    expect(plan.waves).toHaveLength(3);
    for (const wave of plan.waves) {
      expect(wave).toHaveLength(1);
    }
  });

  it('unknown tool treated as non-readonly (safe default)', () => {
    const registry = new ToolRegistry();
    // Don't register any tools — lookup returns undefined

    const calls: ToolCall[] = [
      makeToolCall('1', 'unknown_tool'),
      makeToolCall('2', 'unknown_tool'),
    ];

    const plan = planExecution(calls, (name) => registry.get(name));
    // Each unknown tool gets its own wave (conservative)
    expect(plan.waves).toHaveLength(2);
    expect(plan.waves[0]).toHaveLength(1);
    expect(plan.waves[1]).toHaveLength(1);
  });

  it('maintains original tool order within waves', () => {
    const registry = new ToolRegistry();
    registry.register(makeReadonlyTool('read'));
    registry.register(makeReadonlyTool('grep'));
    registry.register(makeReadonlyTool('glob'));
    registry.register(makeReadonlyTool('ls'));

    const calls: ToolCall[] = [
      makeToolCall('1', 'read'),
      makeToolCall('2', 'grep'),
      makeToolCall('3', 'glob'),
      makeToolCall('4', 'ls'),
    ];

    const plan = planExecution(calls, (name) => registry.get(name));
    expect(plan.waves).toHaveLength(1);
    const waveIds = plan.waves[0]!.map(c => c.id);
    expect(waveIds).toEqual(['1', '2', '3', '4']);
  });
});
