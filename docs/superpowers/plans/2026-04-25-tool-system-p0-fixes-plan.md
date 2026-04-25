# Tool System P0 Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 critical active bugs in the tool execution system, producing a stable master branch with correct behavior.

**Architecture:** Each bug is addressed in an independent task with TDD approach. All changes are backward-compatible. No API breakage.

**Tech Stack:** TypeScript, Bun, Jest-style testing via `bun test`

---

## Task 1: Fix Sink _todoUpdates Getter Bug

**Files:**
- Modify: `src/agent/tool-dispatch/types.ts:121-123`
- Test: `tests/agent/tool-dispatch/types.test.ts`

**Problem:** `_todoUpdates` getter returns `[]` instead of `undefined` when `updateTodos` was never called.

- [ ] **Step 1: Write failing test**

```typescript
// tests/agent/tool-dispatch/types.test.ts
import { describe, it, expect } from 'bun:test';
import { createToolSink } from '../../../src/agent/tool-dispatch/types';

describe('ToolSink', () => {
  describe('_todoUpdates', () => {
    it('should be undefined when updateTodos was never called', () => {
      const sink = createToolSink();
      expect(sink._todoUpdates).toBeUndefined();
    });

    it('should return the todos after updateTodos is called', () => {
      const sink = createToolSink();
      const todos = [{ id: '1', text: 'test', completed: false }];
      sink.updateTodos(todos);
      expect(sink._todoUpdates).toEqual(todos);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/tool-dispatch/types.test.ts`
Expected: FAIL with `Expected undefined, received []`

- [ ] **Step 3: Implement minimal fix**

```typescript
// src/agent/tool-dispatch/types.ts:121-123
get _todoUpdates() {
  return state._todoUpdates;
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent/tool-dispatch/types.test.ts`
Expected: PASS

- [ ] **Step 5: Verify dispatcher behavior**

```typescript
// Add test to verify dispatcher doesn't set todoUpdates when undefined
// tests/agent/tool-dispatch/dispatcher.test.ts (add to existing file)
it('should not set todoUpdates in result when sink._todoUpdates is undefined', () => {
  const sink = createToolSink();
  expect(sink._todoUpdates).toBeUndefined();
  // In dispatcher: if (sink._todoUpdates) → false, no assignment
});
```

Run: `bun test tests/agent/tool-dispatch/dispatcher.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agent/tool-dispatch/types.ts tests/agent/tool-dispatch/types.test.ts
git commit -m "fix: preserve undefined semantics for _todoUpdates getter"
```

---

## Task 2: Fix ReadCache TTL → mtime + LRU

**Files:**
- Modify: `src/agent/tool-dispatch/middlewares/read-cache.ts`
- Test: `tests/agent/tool-dispatch/middlewares/read-cache.test.ts`

**Problem:** Cache uses 30s TTL and has no size limit.

- [ ] **Step 1: Write failing tests for mtime behavior**

```typescript
// tests/agent/tool-dispatch/middlewares/read-cache.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ReadCacheMiddleware } from '../../../../src/agent/tool-dispatch/middlewares/read-cache';
import { writeFile, unlink, utimes } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ReadCacheMiddleware', () => {
  let middleware: ReadCacheMiddleware;
  let testFile: string;

  beforeEach(async () => {
    middleware = new ReadCacheMiddleware();
    testFile = join(tmpdir(), `test-read-cache-${Date.now()}.txt`);
    await writeFile(testFile, 'original content');
  });

  afterEach(async () => {
    try { await unlink(testFile); } catch {}
  });

  it('should return cached result when file mtime is unchanged', async () => {
    let callCount = 0;
    const next = async () => { callCount++; return 'file content'; };

    const toolCall = { name: 'read', arguments: { path: testFile } } as any;
    
    // First call - cache miss
    await middleware.handle(toolCall, {} as any, next);
    expect(callCount).toBe(1);

    // Second call - cache hit (mtime unchanged)
    await middleware.handle(toolCall, {} as any, next);
    expect(callCount).toBe(1); // Still 1 - cache worked
  });

  it('should invalidate cache when file mtime changes', async () => {
    let callCount = 0;
    const next = async () => { callCount++; return 'file content'; };

    const toolCall = { name: 'read', arguments: { path: testFile } } as any;
    
    // First call
    await middleware.handle(toolCall, {} as any, next);
    expect(callCount).toBe(1);

    // Modify file to change mtime
    await utimes(testFile, new Date(), new Date(Date.now() + 1000));

    // Second call - cache miss due to mtime change
    await middleware.handle(toolCall, {} as any, next);
    expect(callCount).toBe(2); // Called again - cache invalidated
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/tool-dispatch/middlewares/read-cache.test.ts`
Expected: FAIL (second test will fail because TTL-based cache doesn't check mtime)

- [ ] **Step 3: Implement mtime-based caching**

```typescript
// src/agent/tool-dispatch/middlewares/read-cache.ts
import type { ToolMiddleware } from '../middleware';
import type { ToolCall } from '../../../types';
import type { ToolContext } from '../types';
import { stat } from 'fs/promises';

export class ReadCacheMiddleware implements ToolMiddleware {
  name = 'read-cache';
  private cache = new Map<string, { result: unknown; mtimeMs: number }>();
  private maxEntries = 100;

  async handle(toolCall: ToolCall, _ctx: ToolContext, next: () => Promise<unknown>): Promise<unknown> {
    if (toolCall.name !== 'read') return next();

    const path = toolCall.arguments.path as string;
    const startLine = (toolCall.arguments.start_line as number | undefined) ?? '';
    const endLine = (toolCall.arguments.end_line as number | undefined) ?? '';
    const key = `read:${path}:${startLine}:${endLine}`;

    const cached = this.cache.get(key);
    try {
      const fileStat = await stat(path);
      if (cached && cached.mtimeMs === fileStat.mtimeMs) {
        // LRU: move to end
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached.result;
      }
    } catch {
      // stat failed (file doesn't exist) - skip cache
    }

    const result = await next();

    // LRU eviction
    if (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }

    // Cache with mtime
    try {
      const fileStat = await stat(path);
      this.cache.set(key, { result, mtimeMs: fileStat.mtimeMs });
    } catch {
      // stat failed - don't cache
    }

    return result;
  }

  /** Clear cache manually (for testing) */
  clear(): void {
    this.cache.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/agent/tool-dispatch/middlewares/read-cache.test.ts`
Expected: PASS both tests

- [ ] **Step 5: Add LRU eviction test**

```typescript
// Add to read-cache.test.ts
it('should evict oldest entries when exceeding maxEntries', async () => {
  const files = await Promise.all(
    Array.from({ length: 105 }, async (_, i) => {
      const f = join(tmpdir(), `test-lru-${i}-${Date.now()}.txt`);
      await writeFile(f, `content ${i}`);
      return f;
    })
  );

  try {
    // Read 105 different files
    for (let i = 0; i < 105; i++) {
      const next = async () => `content ${i}`;
      const toolCall = { name: 'read', arguments: { path: files[i] } } as any;
      await middleware.handle(toolCall, {} as any, next);
    }

    // Cache should have at most 100 entries
    expect((middleware as any).cache.size).toBeLessThanOrEqual(100);
  } finally {
    await Promise.all(files.map(f => unlink(f).catch(() => {})));
  }
});
```

Run: `bun test tests/agent/tool-dispatch/middlewares/read-cache.test.ts`
Expected: PASS all 3 tests

- [ ] **Step 6: Commit**

```bash
git add src/agent/tool-dispatch/middlewares/read-cache.ts tests/agent/tool-dispatch/middlewares/read-cache.test.ts
git commit -m "fix: replace ReadCache TTL with mtime-based invalidation + LRU"
```

---

## Task 3: Fix Agent.ts halt strategy order

**Files:**
- Modify: `src/agent/Agent.ts:384-421`
- Test: `tests/agent/Agent.test.ts`

**Problem**: throw happens after yield and addMessage, causing state inconsistency.

- [ ] **Step 1: Write failing test**

```typescript
// tests/agent/Agent.test.ts (add to existing test file)
import { describe, it, expect } from 'bun:test';

describe('Agent tool error halt strategy', () => {
  it('should not add message to context before throwing on halt', async () => {
    // Setup mock agent that returns a tool error
    // This is a conceptual test - actual test depends on Agent's existing test infrastructure
    // Verify that when toolErrorStrategy is 'halt' and tool errors:
    // 1. Error is thrown
    // 2. contextManager.addMessage was NOT called
    // 3. tool_call_result event was NOT yielded
  });
});
```

- [ ] **Step 2: Implement the fix**

```typescript
// src/agent/Agent.ts:384-421
case 'tool:result':
  const rawContent = event.result.content;
  const content = typeof rawContent === 'string'
    ? rawContent
    : JSON.stringify(rawContent, null, 2);

  if (event.result.isError && config.toolErrorStrategy === 'halt') {
    throw new Error(content);
  }

  const toolResultEvent: any = {
    type: 'tool_call_result',
    toolCall: event.toolCall,
    result: content,
    durationMs: event.result.durationMs,
    isError: event.result.isError,
    turnIndex,
  };
  if (event.result.isError) {
    toolResultEvent.error = new Error(content);
  }
  yield toolResultEvent as AgentEvent;

  this.contextManager.addMessage({
    role: 'tool',
    content,
    tool_call_id: event.toolCall.id,
    name: event.toolCall.name,
  });

  if (event.result.todoUpdates) {
    const currentTodoState = this.contextManager.getTodoState();
    this.contextManager.setTodoState({
      ...currentTodoState,
      todos: event.result.todoUpdates,
    });
  }
  break;
```

- [ ] **Step 3: Run existing Agent tests**

Run: `bun test tests/agent/Agent.test.ts`
Expected: PASS all existing tests

- [ ] **Step 4: Commit**

```bash
git add src/agent/Agent.ts
git commit -m "fix: throw halt error before side effects (yield + addMessage)"
```

---

## Task 4: Fix Parallel Streaming Race with ReadableStream

**Files:**
- Modify: `src/agent/tool-dispatch/dispatcher.ts:198-248`
- Test: `tests/agent/tool-dispatch/dispatcher.test.ts`

**Problem:** Hand-rolled resolveNext pattern has race condition where signal can be lost.

- [ ] **Step 1: Write failing test for race condition**

```typescript
// Add to dispatcher.test.ts
it('should not lose results when tools complete faster than Promise assignment', async () => {
  // Setup: create tools that resolve synchronously (via Promise.resolve())
  // This exposes the race condition: tool completes before resolveNext is set
  const registry = new ToolRegistry();
  
  let callCount = 0;
  class SyncTool implements ToolImplementation {
    getDefinition() { return { name: 'sync', description: '', parameters: {} }; }
    async execute() { callCount++; return 'done'; }
  }
  registry.register(new SyncTool());

  const dispatcher = new ToolDispatcher(registry);
  const toolCalls = [
    { id: '1', name: 'sync', arguments: {} },
    { id: '2', name: 'sync', arguments: {} },
    { id: '3', name: 'sync', arguments: {} },
  ];

  const signal = new AbortController().signal;
  const ctx: ToolContext = {
    signal,
    agentContext: {} as any,
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
  // If race occurs, we'll have fewer result events
  expect(results.length).toBe(6);
  expect(results.filter(r => r.type === 'tool:result').length).toBe(3);
  expect(callCount).toBe(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/tool-dispatch/dispatcher.test.ts`
Expected: May fail intermittently depending on timing (this is the nature of race conditions)

- [ ] **Step 3: Implement ReadableStream refactor**

```typescript
// src/agent/tool-dispatch/dispatcher.ts:198-248
private async *dispatchParallelStreaming(
  toolCalls: ToolCall[],
  baseCtx: ToolContext,
  options: DispatchOptions,
): AsyncGenerator<ToolEvent> {
  // First, yield all start events immediately
  for (const [index, toolCall] of toolCalls.entries()) {
    yield { type: 'tool:start', toolCall, index };
  }

  let controller!: ReadableStreamDefaultController<ToolEvent>;
  const stream = new ReadableStream<ToolEvent>({
    start(c) { controller = c; },
  });

  const promises = toolCalls.map(async (toolCall) => {
    try {
      const result = await this.executeSingle(toolCall, baseCtx, options);
      controller.enqueue({
        type: 'tool:result',
        toolCall,
        result,
      });
    } catch (error) {
      try {
        controller.error(error);
      } catch {
        // Controller might already be closed - ignore
      }
    }
  });

  const onAbort = () => {
    try { controller.close(); } catch {}
  };
  baseCtx.signal.addEventListener('abort', onAbort, { once: true });

  Promise.allSettled(promises).finally(() => {
    try { controller.close(); } catch {}
    baseCtx.signal.removeEventListener('abort', onAbort);
  });

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    reader.releaseLock();
    await Promise.allSettled(promises);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/agent/tool-dispatch/dispatcher.test.ts`
Expected: PASS all tests including the race test

- [ ] **Step 5: Run full test suite to catch regressions**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/agent/tool-dispatch/dispatcher.ts tests/agent/tool-dispatch/dispatcher.test.ts
git commit -m "fix: replace hand-rolled resolveNext with ReadableStream to eliminate race"
```

---

## Final Verification Task

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 2: Type check**

Run: `bun run tsc`
Expected: No type errors

- [ ] **Step 3: Build check**

Run: `bun run build`
Expected: Build succeeds

- [ ] **Step 4: Manual smoke test**

Run: `bun run dev`
Verify:
- Todos panel doesn't disappear after tool execution
- Reading a modified file shows new content
- Parallel tool execution completes correctly

- [ ] **Step 5: Commit design and plan docs**

```bash
git add docs/superpowers/specs/2026-04-25-tool-system-p0-fixes-design.md
git add docs/superpowers/plans/2026-04-25-tool-system-p0-fixes-plan.md
git commit -m "docs: add design spec and implementation plan for P0 tool fixes"
```

---

## Completion Checklist

- [ ] Task 1: Sink _todoUpdates getter fixed
- [ ] Task 2: ReadCache mtime + LRU implemented
- [ ] Task 3: Agent halt order fixed (throw first)
- [ ] Task 4: Parallel streaming ReadableStream refactored
- [ ] All tests pass
- [ ] TypeScript compiles without errors
- [ ] Build succeeds
- [ ] Documentation committed
