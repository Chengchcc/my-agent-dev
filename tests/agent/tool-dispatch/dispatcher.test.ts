import { describe, it, expect } from 'bun:test';
import { ToolDispatcher } from '../../../src/agent/tool-dispatch/dispatcher';
import { ToolRegistry } from '../../../src/agent/tool-registry';
import { createToolSink, type ToolContext, type ToolEvent } from '../../../src/agent/tool-dispatch/types';
import type { ToolImplementation, ToolCall } from '../../../src/types';

describe('ToolDispatcher dispatchParallelStreaming', () => {
  it('should yield all results even when tools complete synchronously (race regression)', async () => {
    // Create tools that resolve synchronously via Promise.resolve()
    // This exposes the old race condition: tool completes before resolveNext is set
    const registry = new ToolRegistry();

    let callCount = 0;
    class SyncTool implements ToolImplementation {
      getDefinition() { return { name: 'sync', description: '', parameters: {} }; }
      async execute(_params: Record<string, unknown>, _ctx: ToolContext) { callCount++; return 'done'; }
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

  it('should abort tool via AbortController on timeout, setting signal.aborted', async () => {
    let signalAborted = false;
    class TimeoutTool implements ToolImplementation {
      getDefinition() { return { name: 'timeoutTool', description: '', parameters: {} }; }
      async execute(_params: Record<string, unknown>, ctx: ToolContext) {
        return new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            signalAborted = true;
            resolve('aborted');
          }, { once: true });
          // Keep the promise pending until abort fires
        });
      }
    }

    const registry = new ToolRegistry();
    registry.register(new TimeoutTool());
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
      { id: '1', name: 'timeoutTool', arguments: {} },
    ];

    const results: ToolEvent[] = [];
    for await (const event of dispatcher.dispatch(toolCalls, ctx, {
      parallel: false,
      yieldAsCompleted: false,
      toolTimeoutMs: 10,
      maxOutputChars: 1000,
    })) {
      results.push(event);
    }

    expect(signalAborted).toBe(true);
    // The result should be the timeout error
    const resultEvent = results.find(r => r.type === 'tool:result') as any;
    expect(resultEvent).toBeDefined();
    expect(resultEvent.result.isError).toBe(true);
    expect(resultEvent.result.content).toContain('timed out');
  });

  it('should propagate external abort to tool signal', async () => {
    let toolSignalAborted = false;
    class AbortAwareTool implements ToolImplementation {
      getDefinition() { return { name: 'abortAware', description: '', parameters: {} }; }
      async execute(_params: Record<string, unknown>, ctx: ToolContext) {
        return new Promise((resolve, reject) => {
          ctx.signal.addEventListener('abort', () => {
            toolSignalAborted = true;
            reject(new Error('aborted'));
          }, { once: true });
          // Keep pending until external abort fires
        });
      }
    }

    const registry = new ToolRegistry();
    registry.register(new AbortAwareTool());
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
      { id: '1', name: 'abortAware', arguments: {} },
    ];

    const results: ToolEvent[] = [];
    const dispatchPromise = (async () => {
      for await (const event of dispatcher.dispatch(toolCalls, ctx, {
        parallel: false,
        yieldAsCompleted: false,
        toolTimeoutMs: 10000,
        maxOutputChars: 1000,
      })) {
        results.push(event);
      }
    })();

    // Abort externally while tool is waiting
    await new Promise(resolve => setTimeout(resolve, 10));
    ctrl.abort();

    await dispatchPromise;

    expect(toolSignalAborted).toBe(true);
    // The result should indicate error (tool rejected with 'aborted')
    const resultEvent = results.find(r => r.type === 'tool:result') as any;
    expect(resultEvent).toBeDefined();
    expect(resultEvent.result.isError).toBe(true);
  });

  it('should not affect non-timeout normal tools', async () => {
    class FastTool implements ToolImplementation {
      getDefinition() { return { name: 'fast', description: '', parameters: {} }; }
      async execute(_params: Record<string, unknown>, ctx: ToolContext) {
        return 'fast result';
      }
    }

    const registry = new ToolRegistry();
    registry.register(new FastTool());
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
      { id: '1', name: 'fast', arguments: {} },
    ];

    const results: ToolEvent[] = [];
    for await (const event of dispatcher.dispatch(toolCalls, ctx, {
      parallel: false,
      yieldAsCompleted: false,
      toolTimeoutMs: 10000,
      maxOutputChars: 1000,
    })) {
      results.push(event);
    }

    expect(results.length).toBe(2); // start + result
    const resultEvent = results.find(r => r.type === 'tool:result') as any;
    expect(resultEvent).toBeDefined();
    expect(resultEvent.result.isError).toBe(false);
    expect(resultEvent.result.content).toBe('fast result');
  });

  it('should handle abort signal during parallel execution', async () => {
    class SlowTool implements ToolImplementation {
      getDefinition() { return { name: 'slow', description: '', parameters: {} }; }
      async execute(_params: Record<string, unknown>, _ctx: ToolContext) {
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
