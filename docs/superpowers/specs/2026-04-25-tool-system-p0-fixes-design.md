# Tool System P0 Bug Fixes Design Document

**Date**: 2026-04-25
**Status**: Draft → Approved
**Scope**: P0 Active Bugs Only (4 fixes)

---

## Overview

This document specifies fixes for 4 critical active bugs in the tool execution system. These are user-visible bugs that cause incorrect behavior.

---

## Bug 1: Sink _todoUpdates Getter Always Returns Array

### Problem

In `src/agent/tool-dispatch/types.ts`, the `_todoUpdates` getter returns:
```typescript
get _todoUpdates() {
  return state._todoUpdates ?? [];  // Always returns array, never undefined
}
```

This causes the dispatcher's check `if (sink._todoUpdates)` to always pass:
```typescript
if (sink._todoUpdates) {  // [] is truthy, condition always true
  result.todoUpdates = sink._todoUpdates;
}
```

Result: **Every tool execution sets `todoUpdates: []`**, which Agent.ts uses to overwrite the real todo state. User sees "todos disappear after clicking any tool".

### Fix

```typescript
// types.ts:121-123
get _todoUpdates() {
  return state._todoUpdates;  // Preserve undefined semantics
}
```

### Acceptance Criteria

- Tool that does NOT call `updateTodos` → `sink._todoUpdates === undefined`
- Dispatcher `if (sink._todoUpdates)` evaluates to false
- `result.todoUpdates` NOT set for such tools
- Agent.ts does NOT overwrite todo state with empty array

---

## Bug 2: ReadCache Uses TTL Instead of mtime

### Problem

`ReadCacheMiddleware` caches file reads with a 30-second TTL, ignoring file modifications:
- Agent modifies file A
- 30 seconds within, agent reads file A again → gets OLD cached content
- Agent makes decisions based on stale data → incorrect modifications

Additionally, cache is unbounded `Map` → memory leak in long sessions.

### Fix

Replace TTL-based invalidation with **mtime-based + LRU eviction**:

```typescript
class ReadCacheMiddleware implements ToolMiddleware {
  name = 'read-cache';
  private cache = new Map<string, { result: unknown; mtimeMs: number }>();
  private maxEntries = 100;

  async handle(toolCall: ToolCall, _ctx: ToolContext, next: () => Promise<unknown>): Promise<unknown> {
    if (toolCall.name !== 'read') return next();

    const path = toolCall.arguments.path;
    const startLine = toolCall.arguments.start_line ?? '';
    const endLine = toolCall.arguments.end_line ?? '';
    const key = `read:${path}:${startLine}:${endLine}`;

    // Check cache validity via mtime
    const cached = this.cache.get(key);
    try {
      const stat = await fs.promises.stat(path);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
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
      const stat = await fs.promises.stat(path);
      this.cache.set(key, { result, mtimeMs: stat.mtimeMs });
    } catch {
      // stat failed - don't cache
    }

    return result;
  }
}
```

### Acceptance Criteria

- File modified → cache invalidated
- Same mtime → cache hit
- Cache never exceeds 100 entries
- File not found → not cached

---

## Bug 3: Agent.ts halt strategy throw happens after yield

### Problem

```typescript
yield toolResultEvent as AgentEvent;    // 1. Event already consumed
this.contextManager.addMessage({...});  // 2. Message already in context
...
if (event.result.isError && config.toolErrorStrategy === 'halt') {
  throw new Error(content);            // 3. Now throw
}
```

State inconsistency:
- TUI already showed the tool result
- Message already in context
- But agent loop throws and exits
- Next run resumes with inconsistent context state

### Fix

Check halt condition BEFORE side effects:

```typescript
// Agent.ts
case 'tool:result':
  // Build content...
  
  if (event.result.isError && config.toolErrorStrategy === 'halt') {
    throw new Error(content);  // Early throw - no yield, no addMessage
  }
  
  yield toolResultEvent as AgentEvent;
  this.contextManager.addMessage({...});
  
  if (event.result.todoUpdates) {
    // Update todos...
  }
  break;
```

### Acceptance Criteria

- Halt strategy triggers → throw happens first
- No tool result event yielded
- No message added to context
- Agent loop exits cleanly with consistent state

---

## Bug 4: Parallel Streaming Signal Loss Race Condition

### Problem

Hand-rolled `resolveNext` pattern has classic race:
1. Consumer awaits `new Promise(resolve => { resolveNext = resolve; })`
2. Producer completes → `resolveNext?.()`
3. If producer completes BEFORE `resolveNext = resolve` assignment → signal lost
4. Consumer deadlocks waiting

### Fix

Replace hand-rolled coordination with **Web Standard ReadableStream**:

```typescript
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
      controller.error(error);
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

### Acceptance Criteria

- No race condition - ReadableStream internally handles queuing
- All results yielded as they complete
- Abort signal properly handled
- Cleanup on completion/abort

---

## Overall Test Plan

### Unit Tests

1. `_todoUpdates` getter test - verify undefined semantics
2. ReadCache mtime test - modify file, verify cache miss
3. ReadCache LRU test - >100 entries, verify eviction
4. Parallel streaming race test - fast-completing promises don't lose signals

### Integration Tests

1. End-to-end: execute tool that does NOT update todos, verify todos panel unchanged
2. End-to-end: read file → modify → read again, verify second read gets new content

---

## Dependencies & Risks

### Dependencies

- Node.js built-in `ReadableStream` (available in Node 18+, Bun fully supports)
- `fs.promises.stat` - standard Node API

### Risks

| Risk | Mitigation |
|------|------------|
| ReadStream vs for-await-of compatibility | Test with actual streaming use case |
| mtime precision issues on some filesystems | Accept: mtimeMs has 1ms precision, sufficient for this use case |
| Race in test environment | Add deterministic test using Promise.resolve() |

---

## Out of Scope (P1/P2)

These are NOT included in this fix, planned for follow-up PRs:

- `ctx: any` → `ToolContext` type tightening (P1)
- ZodTool passing ctx to handle (P1)
- Zod schema Union/Date handling (P1)
- withTimeout AbortController integration (P1)
- Default middleware chain (P2)
- Dead code removal (P2)

---

## Approval

This design has been reviewed and approved for implementation.
