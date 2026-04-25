import { describe, it, expect } from 'bun:test';
import { ToolDispatcher } from '../../../src/agent/tool-dispatch/dispatcher';
import { ToolRegistry } from '../../../src/agent/tool-registry';
import { createToolSink } from '../../../src/agent/tool-dispatch/types';
import type { ToolImplementation, ToolCall } from '../../../src/types';
import type { ToolContext, ToolEvent } from '../../../src/agent/tool-dispatch/types';

describe('ToolDispatcher dispatchParallelStreaming', () => {
  it('should yield all results even when tools complete synchronously (race regression)', async () => {
    // Create tools that resolve synchronously via Promise.resolve()
    // This exposes the old race condition: tool completes before resolveNext is set
    const registry = new ToolRegistry();

    let callCount = 0;
    class SyncTool implements ToolImplementation {
      getDefinition() { return { name: 'sync', description: '', parameters: {} }; }
      async execute() { callCount++; return 'done'; }
    }
    registry.register(new SyncTool());

    const dispatcher = new ToolDispatcher(registry);
    const toolCalls: ToolCall[] = [
      { id: '1', name: 'sync', arguments: {} },
      { id: '2', name: 'sync', arguments: {} },
      { id: '3', name: 'sync', arguments: {} },
    ];

    const ctrl = new AbortController();
    const ctx: ToolContext = {
      signal: ctrl.signal,
      agentContext: { messages: [] } as any,
      budget: { remaining: 1000, usageRatio: 0 },
      environment: { agentType: 'main', cwd: process.cwd() },
      metadata: new Map(),
      sink: createToolSink(),
    };

    const results: ToolEvent[] = [];
    for await (const event of dispatcher.dispatch(toolCalls, ctx, {
      parallel: true,
      yieldAsCompleted: true,
      toolTimeoutMs: 5000,
      maxOutputChars: 1000,
    })) {
      results.push(event);
    }

    // 3 start + 3 result = 6 events total
    // If race occurs, we'd have fewer result events
    expect(results.length).toBe(6);
    expect(results.filter(r => r.type === 'tool:result').length).toBe(3);
    expect(callCount).toBe(3);
  });

  it('should handle empty tool calls', async () => {
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);

    const ctrl = new AbortController();
    const ctx: ToolContext = {
      signal: ctrl.signal,
      agentContext: { messages: [] } as any,
      budget: { remaining: 1000, usageRatio: 0 },
      environment: { agentType: 'main', cwd: process.cwd() },
      metadata: new Map(),
      sink: createToolSink(),
    };

    const results: ToolEvent[] = [];
    for await (const event of dispatcher.dispatch([], ctx, {
      parallel: true,
      yieldAsCompleted: true,
      toolTimeoutMs: 5000,
      maxOutputChars: 1000,
    })) {
      results.push(event);
    }

    expect(results.length).toBe(0);
  });

  it('should handle abort signal during parallel execution', async () => {
    class SlowTool implements ToolImplementation {
      getDefinition() { return { name: 'slow', description: '', parameters: {} }; }
      async execute() {
        await new Promise(resolve => setTimeout(resolve, 500));
        return 'too late';
      }
    }

    const registry = new ToolRegistry();
    registry.register(new SlowTool());
    const dispatcher = new ToolDispatcher(registry);

    const ctrl = new AbortController();
    const ctx: ToolContext = {
      signal: ctrl.signal,
      agentContext: { messages: [] } as any,
      budget: { remaining: 1000, usageRatio: 0 },
      environment: { agentType: 'main', cwd: process.cwd() },
      metadata: new Map(),
      sink: createToolSink(),
    };

    const toolCalls: ToolCall[] = [
      { id: '1', name: 'slow', arguments: {} },
    ];

    const results: ToolEvent[] = [];
    const dispatchPromise = (async () => {
      for await (const event of dispatcher.dispatch(toolCalls, ctx, {
        parallel: true,
        yieldAsCompleted: true,
        toolTimeoutMs: 10000,
        maxOutputChars: 1000,
      })) {
        results.push(event);
      }
    })();

    // Abort while execution is in flight
    await new Promise(resolve => setTimeout(resolve, 50));
    ctrl.abort();

    await dispatchPromise;

    // Should have a start event at minimum
    expect(results.filter(r => r.type === 'tool:start').length).toBe(1);
    // Should not hang (test proves it completes)
  });
});
