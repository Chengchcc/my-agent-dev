# Tool Dispatch 解耦 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 解耦 `Agent.ts` 中的 tool 执行逻辑到独立的 `ToolDispatcher` 模块，实现可插拔的 ToolMiddleware 系统。

**Architecture:**
- Phase 1: 基础设施 — 创建类型定义和 ToolDispatcher 核心编排逻辑
- Phase 2: Agent 对接 — 将 Agent.ts 中的 tool 执行代码替换为 dispatcher
- Phase 3: Tool 签名统一 — 更新 ToolImplementation 接口签名和相关工具
- Phase 4: Middleware — 实现内置的四个 ToolMiddleware

**Tech Stack:** TypeScript, Bun, Jest

---

## Phase 1: 基础设施（无行为变化）

### Task 1.1: 类型定义文件

**Files:**
- Create: `src/agent/tool-dispatch/types.ts`
- Test: `tests/agent/tool-dispatch/types.test.ts`

- [ ] **Step 1: 创建类型定义文件**

```typescript
// src/agent/tool-dispatch/types.ts
import type { AgentContext, ToolCall, TodoItem } from '../../types';

/**
 * ToolSink — tool 的副作用输出通道（收集式）
 */
export interface ToolSink {
  updateTodos(todos: TodoItem[]): void;
  emitMemoryHint(hint: string): void;
  log(level: 'debug' | 'info' | 'warn', message: string): void;

  readonly _todoUpdates?: TodoItem[];
  readonly _memoryHints: string[];
  readonly _logs: Array<{ level: string; message: string; timestamp: number }>;
}

/**
 * ToolContext — 统一的工具执行上下文
 */
export interface ToolContext {
  signal: AbortSignal;
  agentContext: Readonly<AgentContext>;
  budget: {
    remaining: number;
    usageRatio: number;
  };
  environment: {
    agentType: 'main' | 'sub_agent';
    agentId?: string;
    cwd: string;
  };
  metadata: Map<string, unknown>;
  sink: ToolSink;
}

/**
 * ToolExecutionResult — 单个 tool 的执行结果
 */
export interface ToolExecutionResult {
  content: string;
  rawContent?: unknown;
  durationMs: number;
  isError: boolean;
  metadata?: Record<string, unknown>;
  todoUpdates?: TodoItem[];
}

/**
 * ToolEvent — Dispatcher 产出的事件流
 */
export type ToolEvent =
  | { type: 'tool:start'; toolCall: ToolCall; index: number }
  | { type: 'tool:progress'; toolCall: ToolCall; message: string }
  | { type: 'tool:result'; toolCall: ToolCall; result: ToolExecutionResult }
  | { type: 'tool:error'; toolCall: ToolCall; error: Error; recoverable: boolean };

/**
 * DispatchOptions — 调度选项
 */
export interface DispatchOptions {
  parallel: boolean;
  yieldAsCompleted: boolean;
  toolTimeoutMs: number;
  maxOutputChars: number;
  errorStrategy: 'continue' | 'halt';
}

/**
 * 创建 ToolSink 实例的工厂函数
 */
export function createToolSink(): ToolSink {
  const state: {
    _todoUpdates?: TodoItem[];
    _memoryHints: string[];
    _logs: Array<{ level: string; message: string; timestamp: number }>;
  } = {
    _memoryHints: [],
    _logs: [],
  };

  return {
    updateTodos(todos: TodoItem[]) {
      state._todoUpdates = todos;
    },
    emitMemoryHint(hint: string) {
      state._memoryHints.push(hint);
    },
    log(level: 'debug' | 'info' | 'warn', message: string) {
      state._logs.push({ level, message, timestamp: Date.now() });
    },
    get _todoUpdates() { return state._todoUpdates; },
    get _memoryHints() { return state._memoryHints; },
    get _logs() { return state._logs; },
  };
}
```

- [ ] **Step 2: 创建类型测试文件**

```typescript
// tests/agent/tool-dispatch/types.test.ts
import { createToolSink } from '../../../src/agent/tool-dispatch/types';
import type { TodoItem } from '../../../src/types';

describe('ToolSink', () => {
  it('should collect todo updates', () => {
    const sink = createToolSink();
    const todos: TodoItem[] = [{ id: '1', title: 'test', status: 'pending' }];
    
    sink.updateTodos(todos);
    
    expect(sink._todoUpdates).toEqual(todos);
  });

  it('should collect memory hints', () => {
    const sink = createToolSink();
    
    sink.emitMemoryHint('hint 1');
    sink.emitMemoryHint('hint 2');
    
    expect(sink._memoryHints).toEqual(['hint 1', 'hint 2']);
  });

  it('should collect logs', () => {
    const sink = createToolSink();
    
    sink.log('debug', 'debug message');
    sink.log('info', 'info message');
    
    expect(sink._logs).toHaveLength(2);
    expect(sink._logs[0].level).toBe('debug');
    expect(sink._logs[0].message).toBe('debug message');
    expect(sink._logs[1].level).toBe('info');
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `bun test tests/agent/tool-dispatch/types.test.ts`
Expected: All 3 tests pass

- [ ] **Step 4: Commit**

```bash
git add src/agent/tool-dispatch/types.ts tests/agent/tool-dispatch/types.test.ts
git commit -m "feat(tool-dispatch): add type definitions and ToolSink"
```

---

### Task 1.2: ToolMiddleware 接口文件

**Files:**
- Create: `src/agent/tool-dispatch/middleware.ts`

- [ ] **Step 1: 创建 middleware 接口文件**

```typescript
// src/agent/tool-dispatch/middleware.ts
import type { ToolCall } from '../../types';
import type { ToolContext } from './types';

/**
 * ToolMiddleware — 拦截单个 tool 执行的中间件
 * 洋葱模型：handle 调用 next() 前的代码先执行，next() 返回后的代码后执行
 */
export interface ToolMiddleware {
  /** Middleware 名称（用于调试） */
  name: string;

  /**
   * 拦截 tool 执行
   */
  handle(
    toolCall: ToolCall,
    ctx: ToolContext,
    next: () => Promise<unknown>,
  ): Promise<unknown>;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/tool-dispatch/middleware.ts
git commit -m "feat(tool-dispatch): add ToolMiddleware interface"
```

---

### Task 1.3: 创建 index.ts re-export

**Files:**
- Create: `src/agent/tool-dispatch/index.ts`

- [ ] **Step 1: 创建 re-export 文件**

```typescript
// src/agent/tool-dispatch/index.ts
export * from './types';
export * from './middleware';
export * from './dispatcher';
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/tool-dispatch/index.ts
git commit -m "feat(tool-dispatch): add index re-exports"
```

---

### Task 1.4: ToolDispatcher 核心实现（executeSingle + middleware 链）

**Files:**
- Create: `src/agent/tool-dispatch/dispatcher.ts`
- Test: `tests/agent/tool-dispatch/dispatcher-single.test.ts`

- [ ] **Step 1: 实现 executeSingle 和基础方法**

```typescript
// src/agent/tool-dispatch/dispatcher.ts
import type { ToolCall, ToolImplementation, TodoItem } from '../../types';
import type { ToolRegistry } from '../tool-registry';
import type { ToolMiddleware } from './middleware';
import type { ToolContext, ToolEvent, ToolExecutionResult, DispatchOptions } from './types';
import { createToolSink } from './types';

export class ToolDispatcher {
  constructor(
    private registry: ToolRegistry,
    private middlewares: ToolMiddleware[] = [],
  ) {}

  /**
   * 执行单个 tool — 应用 middleware 链 + 超时 + 序列化 + 副作用收集
   */
  private async executeSingle(
    toolCall: ToolCall,
    baseCtx: ToolContext,
    options: DispatchOptions,
  ): Promise<ToolExecutionResult> {
    const tool = this.registry.get(toolCall.name);
    if (!tool) {
      return {
        content: `Error: Tool '${toolCall.name}' not found.`,
        durationMs: 0,
        isError: true,
      };
    }

    // 每个 tool 有独立的 metadata Map 副本，隔离并行执行
    const toolCtx: ToolContext = {
      ...baseCtx,
      metadata: new Map(baseCtx.metadata),
      sink: createToolSink(),
    };

    // 构建 middleware 洋葱链
    const chain = this.buildMiddlewareChain(tool, toolCall, toolCtx);

    const startTime = Date.now();
    try {
      const rawResult = await this.withTimeout(
        chain(),
        options.toolTimeoutMs,
        toolCall.name,
      );

      const content = this.serializeAndTruncate(rawResult, options.maxOutputChars);
      const durationMs = Date.now() - startTime;

      // 从 sink 收集副作用
      const sink = toolCtx.sink;

      return {
        content,
        rawContent: rawResult,
        durationMs,
        isError: false,
        metadata: Object.fromEntries(toolCtx.metadata),
        todoUpdates: sink._todoUpdates,
      };
    } catch (error) {
      return {
        content: `Error executing '${toolCall.name}': ${error instanceof Error ? error.message : String(error)}`,
        durationMs: Date.now() - startTime,
        isError: true,
      };
    }
  }

  /**
   * 构建 middleware 洋葱链
   * 注册顺序 = 外层到内层（第一个注册的最先执行）
   */
  private buildMiddlewareChain(
    tool: ToolImplementation,
    toolCall: ToolCall,
    ctx: ToolContext,
  ): () => Promise<unknown> {
    let current = () => tool.execute(toolCall.arguments, ctx);
    for (const mw of [...this.middlewares].reverse()) {
      const next = current;
      current = () => mw.handle(toolCall, ctx, next);
    }
    return current;
  }

  /**
   * Promise 超时包装
   */
  private async withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Tool '${toolName}' timed out after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }

  /**
   * 序列化并截断结果
   */
  private serializeAndTruncate(result: unknown, maxChars: number): string {
    const str = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    if (str.length <= maxChars) return str;
    return str.slice(0, maxChars) + `\n\n--- Truncated after ${maxChars} chars ---`;
  }
}
```

- [ ] **Step 2: 添加空的 dispatch 方法（占位，供后续扩展）**

在 `ToolDispatcher` 类中添加：

```typescript
async *dispatch(
  toolCalls: ToolCall[],
  baseCtx: ToolContext,
  options: DispatchOptions,
): AsyncGenerator<ToolEvent> {
  // 占位实现，后续 task 扩展
  yield* this.dispatchSequential(toolCalls, baseCtx, options);
}

private async *dispatchSequential(
  toolCalls: ToolCall[],
  baseCtx: ToolContext,
  options: DispatchOptions,
): AsyncGenerator<ToolEvent> {
  // 占位实现，后续 task 扩展
  for (let i = 0; i < toolCalls.length; i++) {
    const toolCall = toolCalls[i];
    yield { type: 'tool:start', toolCall, index: i };
    const result = await this.executeSingle(toolCall, baseCtx, options);
    yield { type: 'tool:result', toolCall, result };
  }
}
```

- [ ] **Step 3: 创建测试文件**

```typescript
// tests/agent/tool-dispatch/dispatcher-single.test.ts
import { ToolDispatcher } from '../../../src/agent/tool-dispatch/dispatcher';
import { createToolSink } from '../../../src/agent/tool-dispatch/types';
import type { ToolImplementation } from '../../../src/types';

// Mock ToolRegistry
class MockRegistry {
  private tools = new Map<string, ToolImplementation>();
  
  register(tool: ToolImplementation) { this.tools.set(tool.getDefinition().name, tool); }
  get(name: string) { return this.tools.get(name); }
}

describe('ToolDispatcher.executeSingle', () => {
  it('should execute a tool and return result', async () => {
    const mockTool: ToolImplementation = {
      getDefinition: () => ({ name: 'echo', description: '', parameters: {} }),
      execute: async (params) => `Hello ${params.name}`,
    };
    
    const registry = new MockRegistry() as any;
    registry.register(mockTool);
    
    const dispatcher = new ToolDispatcher(registry);
    const ctx = {
      signal: new AbortController().signal,
      agentContext: {} as any,
      budget: { remaining: 1000, usageRatio: 0.5 },
      environment: { agentType: 'main' as const, cwd: '/tmp' },
      metadata: new Map(),
      sink: createToolSink(),
    };
    
    const result = await (dispatcher as any).executeSingle(
      { id: '1', name: 'echo', arguments: { name: 'World' } },
      ctx,
      { parallel: false, yieldAsCompleted: false, toolTimeoutMs: 1000, maxOutputChars: 1000, errorStrategy: 'continue' },
    );
    
    expect(result.content).toBe('Hello World');
    expect(result.isError).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should truncate long output', async () => {
    const mockTool: ToolImplementation = {
      getDefinition: () => ({ name: 'long', description: '', parameters: {} }),
      execute: async () => 'x'.repeat(1000),
    };
    
    const registry = new MockRegistry() as any;
    registry.register(mockTool);
    
    const dispatcher = new ToolDispatcher(registry);
    const ctx = {
      signal: new AbortController().signal,
      agentContext: {} as any,
      budget: { remaining: 1000, usageRatio: 0.5 },
      environment: { agentType: 'main' as const, cwd: '/tmp' },
      metadata: new Map(),
      sink: createToolSink(),
    };
    
    const result = await (dispatcher as any).executeSingle(
      { id: '1', name: 'long', arguments: {} },
      ctx,
      { parallel: false, yieldAsCompleted: false, toolTimeoutMs: 1000, maxOutputChars: 100, errorStrategy: 'continue' },
    );
    
    expect(result.content.length).toBeLessThan(200);
    expect(result.content).toContain('Truncated after 100 chars');
  });

  it('should handle timeout', async () => {
    const mockTool: ToolImplementation = {
      getDefinition: () => ({ name: 'slow', description: '', parameters: {} }),
      execute: async () => {
        await new Promise(r => setTimeout(r, 200));
        return 'done';
      },
    };
    
    const registry = new MockRegistry() as any;
    registry.register(mockTool);
    
    const dispatcher = new ToolDispatcher(registry);
    const ctx = {
      signal: new AbortController().signal,
      agentContext: {} as any,
      budget: { remaining: 1000, usageRatio: 0.5 },
      environment: { agentType: 'main' as const, cwd: '/tmp' },
      metadata: new Map(),
      sink: createToolSink(),
    };
    
    const result = await (dispatcher as any).executeSingle(
      { id: '1', name: 'slow', arguments: {} },
      ctx,
      { parallel: false, yieldAsCompleted: false, toolTimeoutMs: 50, maxOutputChars: 1000, errorStrategy: 'continue' },
    );
    
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out');
  });

  it('should handle tool not found', async () => {
    const registry = new MockRegistry() as any;
    const dispatcher = new ToolDispatcher(registry);
    const ctx = {
      signal: new AbortController().signal,
      agentContext: {} as any,
      budget: { remaining: 1000, usageRatio: 0.5 },
      environment: { agentType: 'main' as const, cwd: '/tmp' },
      metadata: new Map(),
      sink: createToolSink(),
    };
    
    const result = await (dispatcher as any).executeSingle(
      { id: '1', name: 'nonexistent', arguments: {} },
      ctx,
      { parallel: false, yieldAsCompleted: false, toolTimeoutMs: 1000, maxOutputChars: 1000, errorStrategy: 'continue' },
    );
    
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });
});
```

- [ ] **Step 4: 运行测试**

Run: `bun test tests/agent/tool-dispatch/dispatcher-single.test.ts`
Expected: All 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/agent/tool-dispatch/dispatcher.ts tests/agent/tool-dispatch/dispatcher-single.test.ts
git commit -m "feat(tool-dispatch): add executeSingle core logic"
```

---

### Task 1.5: 三种执行模式的完整实现

**Files:**
- Modify: `src/agent/tool-dispatch/dispatcher.ts`
- Test: `tests/agent/tool-dispatch/dispatcher-modes.test.ts`

- [ ] **Step 1: 替换 dispatchSequential 为完整实现**

```typescript
private async *dispatchSequential(
  toolCalls: ToolCall[],
  baseCtx: ToolContext,
  options: DispatchOptions,
): AsyncGenerator<ToolEvent> {
  for (let i = 0; i < toolCalls.length; i++) {
    const toolCall = toolCalls[i];
    yield { type: 'tool:start', toolCall, index: i };
    const result = await this.executeSingle(toolCall, baseCtx, options);
    yield { type: 'tool:result', toolCall, result };
  }
}
```

- [ ] **Step 2: 添加 dispatchParallelBatch 实现**

```typescript
private async *dispatchParallelBatch(
  toolCalls: ToolCall[],
  baseCtx: ToolContext,
  options: DispatchOptions,
): AsyncGenerator<ToolEvent> {
  const results = await Promise.allSettled(
    toolCalls.map(toolCall => this.executeSingle(toolCall, baseCtx, options)),
  );

  for (let i = 0; i < toolCalls.length; i++) {
    const toolCall = toolCalls[i];
    yield { type: 'tool:start', toolCall, index: i };

    const resultItem = results[i];
    let result: ToolExecutionResult;
    if (resultItem.status === 'fulfilled') {
      result = resultItem.value;
    } else {
      const error = resultItem.reason instanceof Error
        ? resultItem.reason
        : new Error(String(resultItem.reason));
      result = {
        content: `Error: ${error.message}`,
        durationMs: 0,
        isError: true,
      };
    }

    yield { type: 'tool:result', toolCall, result };
  }
}
```

- [ ] **Step 3: 添加 dispatchParallelStreaming 实现**

```typescript
private async *dispatchParallelStreaming(
  toolCalls: ToolCall[],
  baseCtx: ToolContext,
  options: DispatchOptions,
): AsyncGenerator<ToolEvent> {
  // First, yield all start events immediately
  for (let i = 0; i < toolCalls.length; i++) {
    yield { type: 'tool:start', toolCall: toolCalls[i], index: i };
  }

  // Use a result queue to yield results as soon as they complete
  const pending = new Set(toolCalls.map(tc => tc.id));
  const resultQueue: ToolEvent[] = [];
  let resolveNext: (() => void) | null = null;

  const promises = toolCalls.map(async (toolCall) => {
    const result = await this.executeSingle(toolCall, baseCtx, options);

    resultQueue.push({
      type: 'tool:result',
      toolCall,
      result,
    });
    pending.delete(toolCall.id);
    resolveNext?.();
  });

  // Yield as results arrive - true incremental streaming
  while (pending.size > 0 || resultQueue.length > 0) {
    if (resultQueue.length > 0) {
      const event = resultQueue.shift()!;
      yield event;
    } else {
      // Wait for the next result to complete
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
        // Resolve on abort - prevents deadlock if all pending tools are hanging
        const onAbort = () => resolve();
        baseCtx.signal.addEventListener('abort', onAbort, { once: true });
        // Cleanup listener after resolve
        const originalResolve = resolve;
        resolve = () => {
          baseCtx.signal.removeEventListener('abort', onAbort);
          originalResolve();
        };
      });
    }
  }

  // Wait for all promises to settle (cleanup any remaining)
  await Promise.allSettled(promises);
}
```

- [ ] **Step 4: 更新 dispatch 方法**

```typescript
async *dispatch(
  toolCalls: ToolCall[],
  baseCtx: ToolContext,
  options: DispatchOptions,
): AsyncGenerator<ToolEvent> {
  if (options.parallel && options.yieldAsCompleted) {
    yield* this.dispatchParallelStreaming(toolCalls, baseCtx, options);
  } else if (options.parallel) {
    yield* this.dispatchParallelBatch(toolCalls, baseCtx, options);
  } else {
    yield* this.dispatchSequential(toolCalls, baseCtx, options);
  }
}
```

- [ ] **Step 5: 创建执行模式测试**

```typescript
// tests/agent/tool-dispatch/dispatcher-modes.test.ts
import { ToolDispatcher } from '../../../src/agent/tool-dispatch/dispatcher';
import { createToolSink } from '../../../src/agent/tool-dispatch/types';
import type { ToolImplementation } from '../../../src/types';

class MockRegistry {
  private tools = new Map<string, ToolImplementation>();
  register(tool: ToolImplementation) { this.tools.set(tool.getDefinition().name, tool); }
  get(name: string) { return this.tools.get(name); }
}

async function collectEvents<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('ToolDispatcher execution modes', () => {
  function createTestTools(): MockRegistry {
    const registry = new MockRegistry();
    registry.register({
      getDefinition: () => ({ name: 'fast', description: '', parameters: {} }),
      execute: async () => 'fast result',
    } as ToolImplementation);
    registry.register({
      getDefinition: () => ({ name: 'slow', description: '', parameters: {} }),
      execute: async () => {
        await new Promise(r => setTimeout(r, 50));
        return 'slow result';
      },
    } as ToolImplementation);
    return registry;
  }

  function createCtx() {
    return {
      signal: new AbortController().signal,
      agentContext: {} as any,
      budget: { remaining: 1000, usageRatio: 0.5 },
      environment: { agentType: 'main' as const, cwd: '/tmp' },
      metadata: new Map(),
      sink: createToolSink(),
    };
  }

  describe('sequential mode', () => {
    it('should execute tools one after another', async () => {
      const registry = createTestTools();
      const dispatcher = new ToolDispatcher(registry as any);

      const events = await collectEvents(dispatcher.dispatch(
        [{ id: '1', name: 'fast', arguments: {} }, { id: '2', name: 'slow', arguments: {} }],
        createCtx(),
        { parallel: false, yieldAsCompleted: false, toolTimeoutMs: 1000, maxOutputChars: 1000, errorStrategy: 'continue' },
      ));

      expect(events).toHaveLength(4); // 2 starts + 2 results
      expect(events[0].type).toBe('tool:start');
      expect(events[1].type).toBe('tool:result');
      expect(events[2].type).toBe('tool:start');
      expect(events[3].type).toBe('tool:result');
    });
  });

  describe('parallel batch mode', () => {
    it('should yield all starts first, then all results', async () => {
      const registry = createTestTools();
      const dispatcher = new ToolDispatcher(registry as any);

      const events = await collectEvents(dispatcher.dispatch(
        [{ id: '1', name: 'fast', arguments: {} }, { id: '2', name: 'slow', arguments: {} }],
        createCtx(),
        { parallel: true, yieldAsCompleted: false, toolTimeoutMs: 1000, maxOutputChars: 1000, errorStrategy: 'continue' },
      ));

      expect(events).toHaveLength(4);
      expect(events[0].type).toBe('tool:start');
      expect(events[1].type).toBe('tool:start');
      expect(events[2].type).toBe('tool:result');
      expect(events[3].type).toBe('tool:result');
    });
  });

  describe('parallel streaming mode', () => {
    it('should yield all starts first, then results as they complete', async () => {
      const registry = createTestTools();
      const dispatcher = new ToolDispatcher(registry as any);

      const events = await collectEvents(dispatcher.dispatch(
        [{ id: '1', name: 'fast', arguments: {} }, { id: '2', name: 'slow', arguments: {} }],
        createCtx(),
        { parallel: true, yieldAsCompleted: true, toolTimeoutMs: 1000, maxOutputChars: 1000, errorStrategy: 'continue' },
      ));

      expect(events).toHaveLength(4);
      expect(events[0].type).toBe('tool:start');
      expect(events[1].type).toBe('tool:start');
      // Results order: fast should complete before slow
      expect(events[2].type).toBe('tool:result');
      expect(events[3].type).toBe('tool:result');
    });
  });
});
```

- [ ] **Step 6: 运行测试**

Run: `bun test tests/agent/tool-dispatch/dispatcher-modes.test.ts`
Expected: All 3 tests pass

- [ ] **Step 7: Commit**

```bash
git add src/agent/tool-dispatch/dispatcher.ts tests/agent/tool-dispatch/dispatcher-modes.test.ts
git commit -m "feat(tool-dispatch): implement all three execution modes"
```

---

### Task 1.6: Middleware 链集成测试

**Files:**
- Test: `tests/agent/tool-dispatch/dispatcher-middleware.test.ts`

- [ ] **Step 1: 创建 middleware 集成测试**

```typescript
// tests/agent/tool-dispatch/dispatcher-middleware.test.ts
import { ToolDispatcher } from '../../../src/agent/tool-dispatch/dispatcher';
import { createToolSink } from '../../../src/agent/tool-dispatch/types';
import type { ToolMiddleware } from '../../../src/agent/tool-dispatch/middleware';
import type { ToolImplementation } from '../../../src/types';

class MockRegistry {
  private tools = new Map<string, ToolImplementation>();
  register(tool: ToolImplementation) { this.tools.set(tool.getDefinition().name, tool); }
  get(name: string) { return this.tools.get(name); }
}

describe('ToolDispatcher middleware chain', () => {
  it('should execute middleware in registration order (outer to inner)', async () => {
    const callOrder: string[] = [];
    
    const outerMiddleware: ToolMiddleware = {
      name: 'outer',
      handle: async (tc, ctx, next) => {
        callOrder.push('outer:before');
        const result = await next();
        callOrder.push('outer:after');
        return result;
      },
    };
    
    const innerMiddleware: ToolMiddleware = {
      name: 'inner',
      handle: async (tc, ctx, next) => {
        callOrder.push('inner:before');
        const result = await next();
        callOrder.push('inner:after');
        return result;
      },
    };

    const mockTool: ToolImplementation = {
      getDefinition: () => ({ name: 'test', description: '', parameters: {} }),
      execute: async () => {
        callOrder.push('tool:execute');
        return 'result';
      },
    };

    const registry = new MockRegistry();
    registry.register(mockTool);

    // 注册顺序：outer 先注册（外层），inner 后注册（内层）
    const dispatcher = new ToolDispatcher(registry as any, [outerMiddleware, innerMiddleware]);

    const ctx = {
      signal: new AbortController().signal,
      agentContext: {} as any,
      budget: { remaining: 1000, usageRatio: 0.5 },
      environment: { agentType: 'main' as const, cwd: '/tmp' },
      metadata: new Map(),
      sink: createToolSink(),
    };

    await (dispatcher as any).executeSingle(
      { id: '1', name: 'test', arguments: {} },
      ctx,
      { parallel: false, yieldAsCompleted: false, toolTimeoutMs: 1000, maxOutputChars: 1000, errorStrategy: 'continue' },
    );

    // 洋葱模型：outer -> inner -> tool -> inner -> outer
    expect(callOrder).toEqual([
      'outer:before',
      'inner:before',
      'tool:execute',
      'inner:after',
      'outer:after',
    ]);
  });

  it('should allow middleware to modify result', async () => {
    const modifierMiddleware: ToolMiddleware = {
      name: 'modifier',
      handle: async (tc, ctx, next) => {
        const result = await next();
        return `modified: ${result}`;
      },
    };

    const mockTool: ToolImplementation = {
      getDefinition: () => ({ name: 'test', description: '', parameters: {} }),
      execute: async () => 'original',
    };

    const registry = new MockRegistry();
    registry.register(mockTool);

    const dispatcher = new ToolDispatcher(registry as any, [modifierMiddleware]);

    const ctx = {
      signal: new AbortController().signal,
      agentContext: {} as any,
      budget: { remaining: 1000, usageRatio: 0.5 },
      environment: { agentType: 'main' as const, cwd: '/tmp' },
      metadata: new Map(),
      sink: createToolSink(),
    };

    const result = await (dispatcher as any).executeSingle(
      { id: '1', name: 'test', arguments: {} },
      ctx,
      { parallel: false, yieldAsCompleted: false, toolTimeoutMs: 1000, maxOutputChars: 1000, errorStrategy: 'continue' },
    );

    expect(result.content).toBe('modified: original');
  });

  it('should allow middleware to intercept and throw errors', async () => {
    const permissionMiddleware: ToolMiddleware = {
      name: 'permission',
      handle: async (tc, ctx, next) => {
        if (tc.name === 'forbidden') {
          throw new Error('Permission denied');
        }
        return next();
      },
    };

    const mockTool: ToolImplementation = {
      getDefinition: () => ({ name: 'forbidden', description: '', parameters: {} }),
      execute: async () => 'should not reach',
    };

    const registry = new MockRegistry();
    registry.register(mockTool);

    const dispatcher = new ToolDispatcher(registry as any, [permissionMiddleware]);

    const ctx = {
      signal: new AbortController().signal,
      agentContext: {} as any,
      budget: { remaining: 1000, usageRatio: 0.5 },
      environment: { agentType: 'main' as const, cwd: '/tmp' },
      metadata: new Map(),
      sink: createToolSink(),
    };

    const result = await (dispatcher as any).executeSingle(
      { id: '1', name: 'forbidden', arguments: {} },
      ctx,
      { parallel: false, yieldAsCompleted: false, toolTimeoutMs: 1000, maxOutputChars: 1000, errorStrategy: 'continue' },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Permission denied');
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `bun test tests/agent/tool-dispatch/dispatcher-middleware.test.ts`
Expected: All 3 tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/agent/tool-dispatch/dispatcher-middleware.test.ts
git commit -m "test(tool-dispatch): add middleware integration tests"
```

---

## Phase 2: Agent.ts 对接

### Task 2.1: 添加 buildToolContext 私有方法

**Files:**
- Modify: `src/agent/Agent.ts:60-80`

- [ ] **Step 1: 在 Agent 类中添加 buildToolContext 方法**

在 `Agent.ts` 的 `abort()` 方法后、`truncateOutput()` 方法前添加：

```typescript
/**
 * Build ToolContext from current agent state
 */
private buildToolContext(agentCtx: any, signal: AbortSignal): any {
  return {
    signal,
    agentContext: Object.freeze({ ...agentCtx }),
    budget: {
      remaining: this.contextManager.getRemainingBudget(),
      usageRatio: this.contextManager.getBudgetUsageRatio(),
    },
    environment: {
      agentType: 'main' as const,
      cwd: process.cwd(),
    },
    metadata: new Map(),
    sink: (() => {
      const state: any = { _memoryHints: [], _logs: [] };
      return {
        updateTodos(todos: any) { state._todoUpdates = todos; },
        emitMemoryHint(hint: string) { state._memoryHints.push(hint); },
        log(level: any, message: string) { state._logs.push({ level, message, timestamp: Date.now() }); },
        get _todoUpdates() { return state._todoUpdates; },
        get _memoryHints() { return state._memoryHints; },
        get _logs() { return state._logs; },
      };
    })(),
  };
}
```

- [ ] **Step 2: 确保 ContextManager 有对应的方法**

检查 `src/agent/context.ts` 是否有 `getRemainingBudget()` 和 `getBudgetUsageRatio()`。如果没有，添加：

```typescript
getRemainingBudget(): number {
  // 计算剩余预算：tokenLimit - currentUsage
  const usage = this.getCurrentUsage();
  return Math.max(0, this.tokenLimit - usage);
}

getBudgetUsageRatio(): number {
  return Math.min(1, this.getCurrentUsage() / this.tokenLimit);
}

private getCurrentUsage(): number {
  // 返回当前 token 使用量
  return this.messages.reduce((sum, msg) => {
    // 简单估算：每个字符 ~0.25 tokens
    return sum + (msg.content?.length || 0) * 0.25;
  }, 0);
}
```

注意：如果现有 context 已经有类似实现，复用即可。

- [ ] **Step 3: 运行现有测试确保不破坏**

Run: `bun test tests/agent/Agent.test.ts`
Expected: All existing tests pass

- [ ] **Step 4: Commit**

```bash
git add src/agent/Agent.ts src/agent/context.ts
git commit -m "feat(agent): add buildToolContext helper method"
```

---

### Task 2.2: 集成 ToolDispatcher 到 Agent 构造函数

**Files:**
- Modify: `src/agent/Agent.ts:1-60`

- [ ] **Step 1: 添加导入**

在 `Agent.ts` 顶部添加：

```typescript
import { ToolDispatcher } from './tool-dispatch/dispatcher';
import type { ToolMiddleware } from './tool-dispatch/middleware';
```

- [ ] **Step 2: 添加私有成员和构造函数参数**

在 Agent 类的私有成员中添加：

```typescript
private dispatcher: ToolDispatcher;
```

更新构造函数签名和实现：

```typescript
constructor(options: {
  provider: Provider;
  contextManager: ContextManager;
  hooks?: AgentHooks;
  config: AgentConfig;
  toolRegistry?: ToolRegistry;
  /** @deprecated Use hooks.beforeModel instead */
  middleware?: Middleware[];
  toolMiddlewares?: ToolMiddleware[];  // 新增
}) {
  this.provider = options.provider;
  this.contextManager = options.contextManager;
  this.config = options.config;
  this.toolRegistry = options.toolRegistry ?? null;
  
  // 初始化 ToolDispatcher
  this.dispatcher = new ToolDispatcher(
    this.toolRegistry ?? new ToolRegistry(),
    options.toolMiddlewares ?? [],
  );
  
  // ... existing hooks initialization code ...
}
```

- [ ] **Step 3: 运行现有测试**

Run: `bun test tests/agent/Agent.test.ts`
Expected: All existing tests pass

- [ ] **Step 4: Commit**

```bash
git add src/agent/Agent.ts
git commit -m "feat(agent): integrate ToolDispatcher in constructor"
```

---

### Task 2.3: 替换 runAgentLoop 中的工具执行代码

**Files:**
- Modify: `src/agent/Agent.ts:500-700`

- [ ] **Step 1: 在 Budget Guard 后替换工具执行代码**

找到 Budget Guard 后的代码（约 500 行开始），找到：

```typescript
// ===== Budget Guard done =====

// i. Execute tool calls
if (config.parallelToolExecution && config.yieldEventsAsToolsComplete) {
  // ~100 lines of parallel streaming code
} else if (config.parallelToolExecution) {
  // ~50 lines of parallel batch code
} else {
  // ~30 lines of sequential code
}
```

替换为：

```typescript
// ===== Budget Guard done =====

// i. Execute tool calls via ToolDispatcher
const toolCtx = this.buildToolContext(resultContext, signal);
const dispatchOptions = {
  parallel: config.parallelToolExecution,
  yieldAsCompleted: config.yieldEventsAsToolsComplete,
  toolTimeoutMs: config.toolTimeoutMs,
  maxOutputChars: config.maxToolOutputChars,
  errorStrategy: config.toolErrorStrategy,
};

for await (const event of this.dispatcher.dispatch(tool_calls, toolCtx, dispatchOptions)) {
  switch (event.type) {
    case 'tool:start':
      yield {
        type: 'tool_call_start',
        toolCall: event.toolCall,
        turnIndex,
      } satisfies any;
      break;

    case 'tool:result':
      yield {
        type: 'tool_call_result',
        toolCall: event.toolCall,
        result: event.result.content,
        error: event.result.isError ? new Error(event.result.content) : undefined,
        durationMs: event.result.durationMs,
        isError: event.result.isError,
        turnIndex,
      } satisfies any;

      // Add tool result to context
      this.contextManager.addMessage({
        role: 'tool',
        content: event.result.content,
        tool_call_id: event.toolCall.id,
        name: event.toolCall.name,
      });

      // Handle todo updates from sink
      if (event.result.todoUpdates) {
        const currentTodoState = this.contextManager.getTodoState();
        this.contextManager.setTodoState({
          ...currentTodoState,
          todos: event.result.todoUpdates,
        });
      }

      // Error strategy: halt on error
      if (event.result.isError && config.toolErrorStrategy === 'halt') {
        throw new Error(event.result.content);
      }
      break;
  }
}
```

- [ ] **Step 2: 删除旧的私有方法**

删除这两个方法：
- `private executeToolCall(...)`
- `private truncateOutput(...)`

- [ ] **Step 3: 运行 Agent 集成测试**

Run: `bun test tests/agent/Agent.test.ts`
Expected: All existing tests pass

- [ ] **Step 4: Commit**

```bash
git add src/agent/Agent.ts
git commit -m "feat(agent): replace tool execution with ToolDispatcher"
```

---

## Phase 3: ToolImplementation 签名统一

### Task 3.1: 更新 ToolImplementation 接口类型

**Files:**
- Modify: `src/types.ts:15-30`

- [ ] **Step 1: 更新 ToolImplementation 接口**

找到：

```typescript
export interface ToolImplementation {
  getDefinition(): Tool;
  execute(params: Record<string, unknown>): Promise<unknown>;
  /** Whether this tool requires access to the full agent context as a second parameter */
  requiresContext?: boolean;
}
```

替换为：

```typescript
import type { ToolContext } from './agent/tool-dispatch';

export interface ToolImplementation {
  getDefinition(): Tool;
  /**
   * Unified signature: all tools receive ToolContext as second parameter.
   * Tools that don't need context can simply ignore it.
   */
  execute(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}
```

- [ ] **Step 2: 运行类型检查**

Run: `bun run tsc --noEmit`
Expected: TypeScript errors only in tools that use `requiresContext`

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): unify ToolImplementation.execute signature"
```

---

### Task 3.2: 适配 SubAgentTool

**Files:**
- Modify: `src/agent/sub-agent-tool.ts`

- [ ] **Step 1: 删除 requiresContext 并更新 execute 签名**

找到：

```typescript
// 删除这行：
// requiresContext = true;
```

更新 execute 签名：

```typescript
async execute(
  params: Record<string, unknown>,
  ctx: ToolContext,  // 从 ctx 获取，不再用 options 模式
): Promise<string> {
  const task = params.task as string;
  const signal = ctx.signal;  // 从 ctx 取 signal

  // 防止递归：只有 main agent 才能 spawn sub_agent
  if (ctx.environment.agentType === 'sub_agent') {
    return 'Error: sub_agent cannot spawn another sub_agent';
  }

  // ... rest of existing code ...
  
  // 把原来的 options?.signal 替换为 signal
  for await (const event of subAgent.runAgentLoop(
    { role: 'user', content: task },
    loopConfig,
    { signal },  // 使用 ctx 中的 signal
  )) {
    // ... existing code ...
  }
}
```

- [ ] **Step 2: 添加导入**

```typescript
import type { ToolContext } from './tool-dispatch';
```

- [ ] **Step 3: 运行 SubAgent 测试**

Run: `bun test tests/agent/sub-agent-tool.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/agent/sub-agent-tool.ts
git commit -m "feat(sub-agent): adapt to ToolContext API"
```

---

### Task 3.3: 适配 TodoWriteTool

**Files:**
- Modify: `src/tools/todo-write.ts`

- [ ] **Step 1: 更新 execute 签名和实现**

```typescript
import type { ToolContext } from '../agent/tool-dispatch';

// 在 execute 中：
async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  // 从 ctx.agentContext 读取当前 todo 状态
  const currentTodos = ctx.agentContext.metadata?.todo?.todos || [];
  
  // 执行操作...
  
  // 通过 sink 更新 todos，不再直接修改 context
  ctx.sink.updateTodos(updatedTodos);
  
  return `Updated ${updatedTodos.length} todo items`;
}
```

- [ ] **Step 2: 删除 requiresContext 字段**

- [ ] **Step 3: 运行 Todo 工具测试**

Run: `bun test tests/tools/todo-write.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/tools/todo-write.ts
git commit -m "feat(todo-tool): adapt to ToolContext and sink API"
```

---

## Phase 4: 内置 ToolMiddleware

### Task 4.1: LoggingMiddleware

**Files:**
- Create: `src/agent/tool-dispatch/middlewares/logging.ts`
- Test: `tests/agent/tool-dispatch/middlewares/logging.test.ts`

- [ ] **Step 1: 实现 LoggingMiddleware**

```typescript
// src/agent/tool-dispatch/middlewares/logging.ts
import type { ToolMiddleware } from '../middleware';

export class LoggingMiddleware implements ToolMiddleware {
  name = 'logging';

  async handle(toolCall: any, ctx: any, next: () => Promise<unknown>) {
    const start = Date.now();
    ctx.sink.log('debug', `[${toolCall.name}] start`);
    try {
      const result = await next();
      ctx.sink.log('info', `[${toolCall.name}] done in ${Date.now() - start}ms`);
      return result;
    } catch (error) {
      ctx.sink.log('warn', `[${toolCall.name}] failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}
```

- [ ] **Step 2: 测试文件**

```typescript
// tests/agent/tool-dispatch/middlewares/logging.test.ts
import { LoggingMiddleware } from '../../../../src/agent/tool-dispatch/middlewares/logging';
import { createToolSink } from '../../../../src/agent/tool-dispatch/types';

describe('LoggingMiddleware', () => {
  it('should log start and completion', async () => {
    const mw = new LoggingMiddleware();
    const sink = createToolSink();

    await mw.handle(
      { name: 'test' },
      { sink },
      async () => 'result',
    );

    expect(sink._logs).toHaveLength(2);
    expect(sink._logs[0].message).toContain('[test] start');
    expect(sink._logs[1].message).toContain('[test] done in');
  });

  it('should log errors', async () => {
    const mw = new LoggingMiddleware();
    const sink = createToolSink();

    try {
      await mw.handle(
        { name: 'failing' },
        { sink },
        async () => { throw new Error('oops'); },
      );
    } catch {}

    expect(sink._logs).toHaveLength(2);
    expect(sink._logs[1].level).toBe('warn');
    expect(sink._logs[1].message).toContain('failed: oops');
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `bun test tests/agent/tool-dispatch/middlewares/logging.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/agent/tool-dispatch/middlewares/logging.ts tests/agent/tool-dispatch/middlewares/logging.test.ts
git commit -m "feat(tool-dispatch): add LoggingMiddleware"
```

---

### Task 4.2: PermissionMiddleware

**Files:**
- Create: `src/agent/tool-dispatch/middlewares/permission.ts`
- Test: `tests/agent/tool-dispatch/middlewares/permission.test.ts`

- [ ] **Step 1: 实现 PermissionMiddleware**

```typescript
// src/agent/tool-dispatch/middlewares/permission.ts
import type { ToolMiddleware } from '../middleware';

export class PermissionMiddleware implements ToolMiddleware {
  name = 'permission';

  constructor(private rules: { denyInSubAgent: string[] }) {}

  async handle(toolCall: any, ctx: any, next: () => Promise<unknown>) {
    if (ctx.environment.agentType === 'sub_agent'
        && this.rules.denyInSubAgent.includes(toolCall.name)) {
      throw new Error(`Tool '${toolCall.name}' is not allowed in sub agent context`);
    }
    return next();
  }
}
```

- [ ] **Step 2: 测试文件**

```typescript
// tests/agent/tool-dispatch/middlewares/permission.test.ts
import { PermissionMiddleware } from '../../../../src/agent/tool-dispatch/middlewares/permission';

describe('PermissionMiddleware', () => {
  it('should deny forbidden tools in sub agent context', async () => {
    const mw = new PermissionMiddleware({ denyInSubAgent: ['bash'] });

    await expect(
      mw.handle(
        { name: 'bash' },
        { environment: { agentType: 'sub_agent' } },
        async () => 'result',
      ),
    ).rejects.toThrow('not allowed in sub agent');
  });

  it('should allow allowed tools in sub agent context', async () => {
    const mw = new PermissionMiddleware({ denyInSubAgent: ['bash'] });

    const result = await mw.handle(
      { name: 'read' },
      { environment: { agentType: 'sub_agent' } },
      async () => 'result',
    );

    expect(result).toBe('result');
  });

  it('should allow all tools in main agent context', async () => {
    const mw = new PermissionMiddleware({ denyInSubAgent: ['bash'] });

    const result = await mw.handle(
      { name: 'bash' },
      { environment: { agentType: 'main' } },
      async () => 'result',
    );

    expect(result).toBe('result');
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `bun test tests/agent/tool-dispatch/middlewares/permission.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/agent/tool-dispatch/middlewares/permission.ts tests/agent/tool-dispatch/middlewares/permission.test.ts
git commit -m "feat(tool-dispatch): add PermissionMiddleware"
```

---

### Task 4.3: BudgetGuardMiddleware

**Files:**
- Create: `src/agent/tool-dispatch/middlewares/budget-guard.ts`
- Test: `tests/agent/tool-dispatch/middlewares/budget-guard.test.ts`

- [ ] **Step 1: 实现 BudgetGuardMiddleware**

```typescript
// src/agent/tool-dispatch/middlewares/budget-guard.ts
import type { ToolMiddleware } from '../middleware';

export class BudgetGuardMiddleware implements ToolMiddleware {
  name = 'budget-guard';

  async handle(toolCall: any, ctx: any, next: () => Promise<unknown>) {
    if (ctx.budget.usageRatio > 0.85) {
      ctx.sink.log('warn', `Budget tight (${(ctx.budget.usageRatio * 100).toFixed(0)}%), proceeding with caution`);
    }
    return next();
  }
}
```

- [ ] **Step 2: 测试文件**

```typescript
// tests/agent/tool-dispatch/middlewares/budget-guard.test.ts
import { BudgetGuardMiddleware } from '../../../../src/agent/tool-dispatch/middlewares/budget-guard';
import { createToolSink } from '../../../../src/agent/tool-dispatch/types';

describe('BudgetGuardMiddleware', () => {
  it('should log warning when budget is tight (>85%)', async () => {
    const mw = new BudgetGuardMiddleware();
    const sink = createToolSink();

    await mw.handle(
      { name: 'test' },
      { budget: { usageRatio: 0.9 }, sink },
      async () => 'result',
    );

    expect(sink._logs.some(l => l.message.includes('Budget tight'))).toBe(true);
  });

  it('should not log warning when budget is healthy', async () => {
    const mw = new BudgetGuardMiddleware();
    const sink = createToolSink();

    await mw.handle(
      { name: 'test' },
      { budget: { usageRatio: 0.5 }, sink },
      async () => 'result',
    );

    expect(sink._logs.some(l => l.message.includes('Budget tight'))).toBe(false);
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `bun test tests/agent/tool-dispatch/middlewares/budget-guard.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/agent/tool-dispatch/middlewares/budget-guard.ts tests/agent/tool-dispatch/middlewares/budget-guard.test.ts
git commit -m "feat(tool-dispatch): add BudgetGuardMiddleware"
```

---

### Task 4.4: ReadCacheMiddleware

**Files:**
- Create: `src/agent/tool-dispatch/middlewares/read-cache.ts`
- Test: `tests/agent/tool-dispatch/middlewares/read-cache.test.ts`

- [ ] **Step 1: 实现 ReadCacheMiddleware**

```typescript
// src/agent/tool-dispatch/middlewares/read-cache.ts
import type { ToolMiddleware } from '../middleware';

export class ReadCacheMiddleware implements ToolMiddleware {
  name = 'read-cache';
  private cache = new Map<string, { result: unknown; timestamp: number }>();
  private ttlMs = 30_000;

  async handle(toolCall: any, ctx: any, next: () => Promise<unknown>) {
    if (toolCall.name !== 'read') return next();

    const path = toolCall.arguments.path;
    const startLine = toolCall.arguments.start_line ?? '';
    const endLine = toolCall.arguments.end_line ?? '';
    const key = `read:${path}:${startLine}:${endLine}`;

    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.ttlMs) {
      return cached.result;
    }

    const result = await next();
    this.cache.set(key, { result, timestamp: Date.now() });
    return result;
  }

  /** Clear cache manually (for testing) */
  clear(): void {
    this.cache.clear();
  }
}
```

- [ ] **Step 2: 测试文件**

```typescript
// tests/agent/tool-dispatch/middlewares/read-cache.test.ts
import { ReadCacheMiddleware } from '../../../../src/agent/tool-dispatch/middlewares/read-cache';

describe('ReadCacheMiddleware', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('should cache read tool results', async () => {
    const mw = new ReadCacheMiddleware();
    let callCount = 0;

    const next = async () => {
      callCount++;
      return 'file content';
    };

    // First call - should execute next()
    const result1 = await mw.handle(
      { name: 'read', arguments: { path: '/test/file.txt' } },
      {},
      next,
    );

    // Second call with same params - should use cache
    const result2 = await mw.handle(
      { name: 'read', arguments: { path: '/test/file.txt' } },
      {},
      next,
    );

    expect(result1).toBe('file content');
    expect(result2).toBe('file content');
    expect(callCount).toBe(1); // Only called once
  });

  it('should not cache other tools', async () => {
    const mw = new ReadCacheMiddleware();
    let callCount = 0;

    const next = async () => {
      callCount++;
      return 'result';
    };

    await mw.handle({ name: 'bash', arguments: {} }, {}, next);
    await mw.handle({ name: 'bash', arguments: {} }, {}, next);

    expect(callCount).toBe(2); // Called twice (no caching)
  });

  it('should invalidate cache after TTL', async () => {
    jest.useFakeTimers();
    const mw = new ReadCacheMiddleware();
    let callCount = 0;

    const next = async () => {
      callCount++;
      return 'file content';
    };

    // First call
    await mw.handle(
      { name: 'read', arguments: { path: '/test/file.txt' } },
      {},
      next,
    );
    expect(callCount).toBe(1);

    // Fast forward 35 seconds
    jest.advanceTimersByTime(35_000);

    // Second call after TTL - should miss cache
    await mw.handle(
      { name: 'read', arguments: { path: '/test/file.txt' } },
      {},
      next,
    );
    expect(callCount).toBe(2);
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `bun test tests/agent/tool-dispatch/middlewares/read-cache.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/agent/tool-dispatch/middlewares/read-cache.ts tests/agent/tool-dispatch/middlewares/read-cache.test.ts
git commit -m "feat(tool-dispatch): add ReadCacheMiddleware"
```

---

### Task 4.5: 在 index.ts 中导出所有 middleware

**Files:**
- Modify: `src/agent/tool-dispatch/index.ts`

- [ ] **Step 1: 更新 re-export**

```typescript
// src/agent/tool-dispatch/index.ts
export * from './types';
export * from './middleware';
export * from './dispatcher';
export * from './middlewares/logging';
export * from './middlewares/permission';
export * from './middlewares/budget-guard';
export * from './middlewares/read-cache';
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/tool-dispatch/index.ts
git commit -m "feat(tool-dispatch): export all built-in middlewares"
```

---

### Task 4.6: 运行完整测试套件并验证 headless 模式

- [ ] **Step 1: 运行所有测试**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 2: 验证 headless 模式**

Run: `echo "list the src directory" | bun run bin/my-agent.ts`
Expected: Works the same as before, no regressions

- [ ] **Step 3: 提交最终 commit**

```bash
git status  # Verify all changes are committed
```

---

## Plan Complete

Total tasks: 16 tasks across 4 phases. Each task is self-contained and testable on its own.
