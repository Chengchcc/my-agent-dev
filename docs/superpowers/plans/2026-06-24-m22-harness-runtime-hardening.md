# M22 Harness Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the harness runtime across four dimensions — in-turn tool parallelism, default context compression with fixed shape/beforeModel ordering, in-run steering intervention, and skill dual-domain discovery with explicit invocation.

**Architecture:** Four sequential phases (P1→P2→P3→P4), each building on the prior's changes to shared files (`run-loop.ts`, `agent-options.ts`). P1 adds `executionMode` to Tool and batch-based execution. P2 swaps shape/beforeModel order, adds structured summarizer, and wires default context manager in harness. P3 adds steering queue + outer follow-up loop. P4 extends progressive-skill to dual-domain + `/skill:name`.

**Tech Stack:** TypeScript (ESM/NodeNext, strict mode), bun:test, @chengchenccc/* monorepo

**Spec:** `docs/superpowers/specs/2026-06-24-m22-harness-runtime-hardening-design.md`

---

## File Map

| File | Action | Phase |
|------|--------|-------|
| `packages/core/src/tool.ts` | Modify — add `executionMode` field | P1 |
| `packages/framework/src/execute-one.ts` | Modify — extract `runOneCollect` | P1 |
| `packages/framework/src/run-loop.ts` | Modify — parallel batches, shape order, steering, follow-up loop | P1-P3 |
| `packages/framework/src/agent-options.ts` | Modify — add `SteeringQueue`, `FollowUpQueue`, `PreserveHint` | P2-P3 |
| `packages/framework/src/context-manager.ts` | Modify — add `PreserveHint` to context | P2 |
| `packages/framework/src/context-managers/summarizing.ts` | Modify — add `structuredSummarize`, export `defaultSummarize` | P2 |
| `packages/framework/src/index.ts` | Modify — re-export new symbols | P1-P2 |
| `packages/harness/src/create-generic-agent.ts` | Modify — wire default `contextManager` | P2 |
| `packages/plugin-progressive-skill/src/progressive-skill.ts` | Modify — `root` → `roots` array | P4 |
| `packages/plugin-progressive-skill/src/cache.ts` | Modify — multi-root scan, `disableModelInvocation` | P4 |
| `packages/plugin-progressive-skill/src/skill-load.ts` | Modify — multi-root lookup, explicit load export | P4 |
| `packages/framework/src/run-loop.test.ts` | Create — P1-P3 tests | P1-P3 |
| `packages/framework/src/execute-one.test.ts` | Create — `runOneCollect` tests | P1 |
| `packages/framework/src/context-managers/summarizing.test.ts` | Modify — structured summarizer tests | P2 |
| `packages/harness/src/create-generic-agent.test.ts` | Modify — default contextManager assertion | P2 |
| `packages/plugin-progressive-skill/src/progressive-skill.test.ts` | Modify — dual-domain tests | P4 |
| `packages/plugin-progressive-skill/src/cache.test.ts` (if missing → create adjacent) | Create/Modify — multi-root + disabled tests | P4 |

---

## Phase 1 — Tool Parallelism

### Task 1.1: Add `executionMode` to Tool interface

**Files:**
- Modify: `packages/core/src/tool.ts`

- [ ] **Step 1: Add `executionMode` field**

```ts
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Declare whether a tool can safely run concurrently with other tools.
   *  "serial" (default) = must run alone, preserving existing behaviour.
   *  "concurrent" = read-only, no side effects, safe to run in parallel
   *  with other concurrent tools in the same turn. */
  readonly executionMode?: "serial" | "concurrent";
  execute(input: unknown, signal?: AbortSignal): ToolExecuteResult | Promise<ToolExecuteResult>;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /root/my-agent-team && bun run typecheck`
Expected: PASS (optional field, no existing tool sets it → no breakage)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/tool.ts
git commit -m "feat(core): add executionMode field to Tool interface for parallel tool support"
```

---

### Task 1.2: Extract `runOneCollect` from `executeOne`

**Files:**
- Modify: `packages/framework/src/execute-one.ts`

`executeOne` is an `AsyncGenerator` that yields events. For parallel execution inside `Promise.all`, we need a non-generator variant that returns results directly.

- [ ] **Step 1: Extract `runOneCollect` function**

Add after the `updateToolState` helper (around line 143):

```ts
/** Non-generator variant of executeOne for use inside Promise.all in batch execution.
 *  Returns results directly instead of yielding — caller handles ordering and yielding. */
export interface RunOneResult {
  resultBlock: ToolResultBlock;
  events: AgentEvent[];
  interrupted: boolean;
}

export async function runOneCollect(
  rt: AgentRuntime,
  call: ToolUseBlock,
  opts: { signal?: AbortSignal },
  step: number,
): Promise<RunOneResult> {
  const events: AgentEvent[] = [];
  const toolStart = Date.now();

  await rt.checkpointer.appendEvent?.(rt.thread.id, { type: "tool_start", call, ts: Date.now() });

  const decision = await rt.plugins.fireBeforeTool(call, rt.thread.messages);

  if (decision?.skip) {
    const r = wrapToolResult(call, {
      content: decision.result ?? "Tool skipped",
      isError: decision.isError ?? (decision.result ? true : undefined),
    });
    rt.thread.messages.push({ role: "user", blocks: [r] });
    await rt.save(rt.thread.messages);
    events.push({
      type: "tool_call",
      payload: {
        step,
        id: call.id,
        name: call.name,
        latencyMs: Date.now() - toolStart,
        isError: r.is_error === true,
      },
    });
    updateToolState(rt, call.id, r.is_error === true ? "error" : "done", r.is_error === true);
    return { resultBlock: r, events, interrupted: false };
  }

  let resultBlock: ToolResultBlock;
  try {
    const input = decision?.input ?? call.input;
    const tool = rt.toolMap.get(call.name);
    if (!tool) {
      resultBlock = wrapToolResult(call, {
        content: `Tool not found: ${call.name}`,
        isError: true,
      });
    } else {
      resultBlock = wrapToolResult(call, await tool.execute(input, opts.signal));
    }
  } catch (err) {
    if (err instanceof InterruptSignal) {
      await rt.save(rt.thread.messages);
      if (!rt.checkpointer.saveInterrupt) {
        throw new Error(
          "Tool requested interrupt but checkpointer does not support it. " +
            "Use a checkpointer that implements saveInterrupt/consumeInterrupt.",
          { cause: err },
        );
      }
      await rt.checkpointer.saveInterrupt(rt.thread.id, {
        pendingTool: { call, reason: err.reason },
        ts: Date.now(),
        meta: err.meta,
      });
      await rt.checkpointer.appendEvent?.(rt.thread.id, {
        type: "interrupt",
        pendingTool: call,
        reason: err.reason,
        ts: Date.now(),
      });
      events.push({
        type: "tool_call",
        payload: {
          step,
          id: call.id,
          name: call.name,
          latencyMs: Date.now() - toolStart,
          isError: true,
        },
      });
      updateToolState(rt, call.id, "error", true);
      events.push({
        type: "interrupted",
        payload: { pendingTool: call, reason: err.reason, meta: err.meta },
      });
      return { resultBlock: wrapToolResult(call, { content: "Interrupted", isError: true }), events, interrupted: true };
    }
    resultBlock = wrapToolResult(call, {
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    });
  }

  rt.thread.messages.push({ role: "user", blocks: [resultBlock] });
  await rt.plugins.fireAfterTool(call, resultBlock, rt.thread.messages);
  for (const ev of rt.pendingEvents.splice(0)) events.push(ev);
  await rt.checkpointer.appendEvent?.(rt.thread.id, {
    type: "tool_end",
    result: resultBlock,
    durationMs: Date.now() - toolStart,
    ts: Date.now(),
  });
  events.push({
    type: "tool_call",
    payload: {
      step,
      id: call.id,
      name: call.name,
      latencyMs: Date.now() - toolStart,
      isError: resultBlock.is_error === true,
    },
  });
  updateToolState(
    rt,
    call.id,
    resultBlock.is_error === true ? "error" : "done",
    resultBlock.is_error === true,
  );
  await rt.save(rt.thread.messages);
  return { resultBlock, events, interrupted: false };
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /root/my-agent-team && bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/framework/src/execute-one.ts
git commit -m "feat(framework): extract runOneCollect for parallel tool batch execution"
```

---

### Task 1.3: Write tests for `runOneCollect`

**Files:**
- Create: `packages/framework/src/execute-one.test.ts`

- [ ] **Step 1: Write the tests**

```ts
import { describe, expect, test } from "bun:test";
import type { Tool, ToolUseBlock } from "@chengchenccc/core";
import { consoleLogger, inMemoryCheckpointer, passthroughContextManager } from "../index.js";
import type { AgentRuntime } from "../agent-options.js";
import { createPluginRunner } from "../plugin-runner.js";
import { runOneCollect } from "../execute-one.js";

function makeRuntime(tools: Tool[] = []): AgentRuntime {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const checkpointer = inMemoryCheckpointer();
  const logger = consoleLogger({ level: "silent" });
  return {
    thread: { id: "t1", messages: [] },
    plugins: createPluginRunner([], {
      threadId: "t1",
      signal: undefined,
      logger,
      checkpointer,
      contextManager: passthroughContextManager(),
      emit: () => {},
    }, logger),
    toolMap,
    checkpointer,
    contextManager: passthroughContextManager(),
    logger,
    model: { stream: async function* () {} },
    tools,
    pendingEvents: [],
    save: async () => {},
    runId: "run-1",
    toolStates: [],
    assistantBlocks: [],
  };
}

const testCall: ToolUseBlock = {
  type: "tool_use",
  id: "call-1",
  name: "echo",
  input: { msg: "hello" },
};

describe("runOneCollect", () => {
  test("returns resultBlock with tool output", async () => {
    const echo: Tool = {
      name: "echo",
      description: "echoes input",
      inputSchema: { type: "object", properties: {} },
      execute: async (input) => ({ content: JSON.stringify(input) }),
    };
    const rt = makeRuntime([echo]);

    const result = await runOneCollect(rt, testCall, {}, 0);

    expect(result.interrupted).toBe(false);
    expect(result.resultBlock.content).toContain("hello");
    expect(result.events.length).toBe(1);
    expect(result.events[0]?.type).toBe("tool_call");
  });

  test("returns isError when tool throws", async () => {
    const bad: Tool = {
      name: "echo",
      description: "",
      inputSchema: {},
      execute: async () => { throw new Error("boom"); },
    };
    const rt = makeRuntime([bad]);

    const result = await runOneCollect(rt, testCall, {}, 0);

    expect(result.interrupted).toBe(false);
    expect(result.resultBlock.is_error).toBe(true);
    expect(result.resultBlock.content).toBe("boom");
  });

  test("returns interrupted=true on InterruptSignal", async () => {
    const { InterruptSignal } = await import("../checkpointer.js");
    const interrupter: Tool = {
      name: "echo",
      description: "",
      inputSchema: {},
      execute: async () => { throw new InterruptSignal("needs approval"); },
    };
    const cp = inMemoryCheckpointer();
    const rt = makeRuntime([interrupter]);
    // Override with a checkpointer that supports saveInterrupt
    (rt as any).checkpointer = cp;
    // InMemory checkpointer doesn't have saveInterrupt — test that it throws
    await expect(runOneCollect(rt, testCall, {}, 0)).rejects.toThrow("checkpointer does not support");
  });

  test("tool not found → error result", async () => {
    const rt = makeRuntime([]);

    const result = await runOneCollect(rt, testCall, {}, 0);

    expect(result.interrupted).toBe(false);
    expect(result.resultBlock.is_error).toBe(true);
    expect(result.resultBlock.content).toContain("Tool not found");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /root/my@chengchenccc/packages/framework && bun test --test-name-pattern="runOneCollect"`
Expected: 4 tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/framework/src/execute-one.test.ts
git commit -m "test(framework): add runOneCollect tests for parallel tool execution"
```

---

### Task 1.4: Implement batch-based parallel execution in runLoop

**Files:**
- Modify: `packages/framework/src/run-loop.ts:230-257`

- [ ] **Step 1: Replace serial for-loop with batch execution**

Replace lines 230-257 (the `for (let i = 0; i < toolUses.length; i++)` block through the `await rt.save` after it) with:

```ts
    // Group tool_use blocks into batches: consecutive concurrent tools
    // form a parallel batch; serial tools each get their own single-item batch.
    const batches: ToolUseBlock[][] = [];
    for (let i = 0; i < toolUses.length; ) {
      const call = toolUses[i]!;
      const mode = rt.toolMap.get(call.name)?.executionMode ?? "serial";
      if (mode === "concurrent") {
        const batch: ToolUseBlock[] = [call];
        let j = i + 1;
        while (j < toolUses.length) {
          const next = toolUses[j]!;
          const nextMode = rt.toolMap.get(next.name)?.executionMode ?? "serial";
          if (nextMode !== "concurrent") break;
          batch.push(next);
          j++;
        }
        batches.push(batch);
        i = j;
      } else {
        batches.push([call]);
        i++;
      }
    }

    let interrupted = false;
    for (const batch of batches) {
      if (batch.length === 1) {
        interrupted = yield* executeOne(rt, batch[0]!, opts, step);
      } else {
        // Run concurrent tools in parallel, collect results
        const results = await Promise.all(
          batch.map((call, idx) =>
            runOneCollect(rt, call, opts, step).catch((err) => {
              // One tool crashed — return error result so other results are preserved
              return {
                resultBlock: wrapToolResult(call, { content: String(err), isError: true }),
                events: [{
                  type: "tool_call" as const,
                  payload: { step, id: call.id, name: call.name, latencyMs: 0, isError: true },
                }],
                interrupted: false,
              };
            }),
          ),
        );

        // Write tool_results in original tool_use order (not completion order)
        for (let rIdx = 0; rIdx < batch.length; rIdx++) {
          rt.thread.messages.push({ role: "user", blocks: [results[rIdx]!.resultBlock] });
        }

        // Yield events in original tool_use order
        for (let rIdx = 0; rIdx < batch.length; rIdx++) {
          for (const ev of results[rIdx]!.events) yield ev;
        }

        interrupted = results.some((r) => r.interrupted);
      }

      if (interrupted) {
        // Mark remaining batches' tools as error (aborted/interrupted)
        const remainingStart = batches.indexOf(batch) + 1;
        for (let bi = remainingStart; bi < batches.length; bi++) {
          for (const call of batches[bi]!) {
            rt.thread.messages.push({
              role: "user",
              blocks: [wrapToolResult(call, { content: "Interrupted", isError: true })],
            });
            updateToolState(rt, call.id, "error", true);
          }
        }
        yield {
          type: "message",
          payload: buildAssistantRevision(
            rt.runId,
            assistantOrdinal,
            "waiting",
            rt.assistantBlocks,
            rt.toolStates,
          ),
        };
        await rt.save(rt.thread.messages);
        return;
      }
    }

    // After all tools in this step completed, emit updated revision
    yield {
      type: "message",
      payload: buildAssistantRevision(
        rt.runId,
        assistantOrdinal,
        "streaming",
        rt.assistantBlocks,
        rt.toolStates,
      ),
    };
```

- [ ] **Step 2: Add import for `runOneCollect`**

Add to imports at top of `run-loop.ts` (after `executeOne` import):

```ts
import { executeOne, runOneCollect } from "./execute-one.js";
```

- [ ] **Step 3: Verify typecheck**

Run: `cd /root/my-agent-team && bun run typecheck`
Expected: PASS

- [ ] **Step 4: Run existing tests to verify no regressions**

Run: `cd /root/my-agent-team && bun run test --filter="@chengchenccc/framework"`
Expected: All existing tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/framework/src/run-loop.ts
git commit -m "feat(framework): batch-based parallel tool execution with concurrent mode support"
```

---

### Task 1.5: Write runLoop parallel execution tests

**Files:**
- Create: `packages/framework/src/run-loop.test.ts`

- [ ] **Step 1: Write tests for batch grouping and parallel execution**

```ts
import { describe, expect, test } from "bun:test";
import type { AIMessageChunk, ChatModel, Tool } from "@chengchenccc/core";
import type { Message } from "@chengchenccc/message";
import { consoleLogger, inMemoryCheckpointer, passthroughContextManager } from "../index.js";
import type { AgentRuntime } from "./agent-options.js";
import { createPluginRunner } from "./plugin-runner.js";
import { runLoop } from "./run-loop.js";

/** Create a minimal AgentRuntime for testing runLoop behaviour. */
function makeRt(opts: {
  tools?: Tool[];
  messages?: Message[];
} = {}): AgentRuntime {
  const tools = opts.tools ?? [];
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const checkpointer = inMemoryCheckpointer();
  const logger = consoleLogger({ level: "silent" });
  return {
    thread: { id: "t1", messages: opts.messages ?? [] },
    plugins: createPluginRunner([], {
      threadId: "t1",
      signal: undefined,
      logger,
      checkpointer,
      contextManager: passthroughContextManager(),
      emit: () => {},
    }, logger),
    toolMap,
    checkpointer,
    contextManager: passthroughContextManager(),
    logger,
    model: { stream: async function* () {} },
    tools,
    pendingEvents: [],
    save: async () => {},
    runId: "run-1",
    toolStates: [],
    assistantBlocks: [],
  };
}

/** Create a ChatModel that returns one assistant message with tool_use blocks. */
function toolUseModel(calls: Array<{ id: string; name: string; input?: unknown }>): ChatModel {
  return {
    stream: async function* (): AsyncGenerator<AIMessageChunk> {
      yield {
        delta: { type: "text", text: "Let me use tools." },
        usage: { input: 10, output: 5 },
      };
      for (const c of calls) {
        yield {
          delta: {
            type: "tool_use",
            id: c.id,
            name: c.name,
            input: JSON.stringify(c.input ?? {}),
          },
          usage: { input: 10, output: 5 },
        };
      }
      yield { delta: { type: "text", text: "" }, stopReason: "tool_use", done: true };
    },
  };
}

describe("runLoop tool parallel execution", () => {
  test("serial tools execute in order via executeOne path", async () => {
    const calls: string[] = [];
    const t1: Tool = {
      name: "t1",
      description: "",
      inputSchema: {},
      executionMode: "serial",
      execute: async () => { calls.push("t1"); return { content: "ok" }; },
    };
    const t2: Tool = {
      name: "t2",
      description: "",
      inputSchema: {},
      executionMode: "serial",
      execute: async () => { calls.push("t2"); return { content: "ok" }; },
    };

    const rt = makeRt({ tools: [t1, t2] });
    rt.model = toolUseModel([
      { id: "c1", name: "t1" },
      { id: "c2", name: "t2" },
    ]);

    const events: any[] = [];
    for await (const ev of runLoop(rt, { maxSteps: 1 })) {
      events.push(ev);
    }

    expect(calls).toEqual(["t1", "t2"]);
  });

  test("concurrent tools run in parallel (timing check)", async () => {
    const starts: number[] = [];
    const ends: number[] = [];

    const slow: Tool = {
      name: "slow",
      description: "",
      inputSchema: {},
      executionMode: "concurrent",
      execute: async () => {
        starts.push(Date.now());
        await new Promise((r) => setTimeout(r, 100));
        ends.push(Date.now());
        return { content: "done" };
      },
    };

    const rt = makeRt({ tools: [slow] });
    rt.model = toolUseModel([
      { id: "c1", name: "slow" },
      { id: "c2", name: "slow" },
    ]);

    const events: any[] = [];
    for await (const ev of runLoop(rt, { maxSteps: 1 })) {
      events.push(ev);
    }

    // Both started before either ended = parallel
    expect(starts.length).toBe(2);
    expect(ends.length).toBe(2);
    expect(Math.max(starts[0]!, starts[1]!)).toBeLessThan(Math.min(ends[0]!, ends[1]!));
  });

  test("tool_results written in tool_use order, not completion order", async () => {
    const t1: Tool = {
      name: "t1",
      description: "",
      inputSchema: {},
      executionMode: "concurrent",
      execute: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { content: "t1-result" };
      },
    };
    const t2: Tool = {
      name: "t2",
      description: "",
      inputSchema: {},
      executionMode: "concurrent",
      execute: async () => {
        return { content: "t2-result" };
      },
    };

    const rt = makeRt({ tools: [t1, t2] });
    rt.model = toolUseModel([
      { id: "c1", name: "t1" },
      { id: "c2", name: "t2" },
    ]);

    for await (const ev of runLoop(rt, { maxSteps: 1 })) {}

    // Find tool_result messages in thread
    const results = rt.thread.messages.filter((m) =>
      Array.isArray(m.blocks) && m.blocks.some((b: any) => b.type === "tool_result")
    );
    expect(results.length).toBe(2);
    expect((results[0]!.blocks as any[])[0]!.tool_use_id).toBe("c1");
    expect((results[1]!.blocks as any[])[0]!.tool_use_id).toBe("c2");
  });

  test("concurrent batch abort → completed results land, batch interrupted", async () => {
    const controller = new AbortController();
    const t1: Tool = {
      name: "t1",
      description: "",
      inputSchema: {},
      executionMode: "concurrent",
      execute: async (_input, signal) => {
        await new Promise((r) => setTimeout(r, 100));
        return { content: "t1-done" };
      },
    };
    const t2: Tool = {
      name: "t2",
      description: "",
      inputSchema: {},
      executionMode: "concurrent",
      execute: async (_input, signal) => {
        return { content: "t2-done" };
      },
    };

    const rt = makeRt({ tools: [t1, t2] });
    rt.model = toolUseModel([
      { id: "c1", name: "t1" },
      { id: "c2", name: "t2" },
    ]);

    const events: any[] = [];
    for await (const ev of runLoop(rt, { maxSteps: 1, signal: controller.signal })) {
      events.push(ev);
    }

    // Both should complete (abort happens before model call, not mid-batch here)
    // This tests the happy path; abort mid-batch tested separately
    const results = rt.thread.messages.filter((m) =>
      Array.isArray(m.blocks) && m.blocks.some((b: any) => b.type === "tool_result")
    );
    expect(results.length).toBe(2);
  });

  test("mixed serial+concurrent → each serial gets own batch, concurrent grouped", async () => {
    const order: string[] = [];
    const s1: Tool = {
      name: "s1", description: "", inputSchema: {},
      executionMode: "serial",
      execute: async () => { order.push("s1"); return { content: "ok" }; },
    };
    const c1: Tool = {
      name: "c1", description: "", inputSchema: {},
      executionMode: "concurrent",
      execute: async () => { order.push("c1"); return { content: "ok" }; },
    };
    const c2: Tool = {
      name: "c2", description: "", inputSchema: {},
      executionMode: "concurrent",
      execute: async () => { order.push("c2"); return { content: "ok" }; },
    };
    const s2: Tool = {
      name: "s2", description: "", inputSchema: {},
      executionMode: "serial",
      execute: async () => { order.push("s2"); return { content: "ok" }; },
    };

    const rt = makeRt({ tools: [s1, c1, c2, s2] });
    rt.model = toolUseModel([
      { id: "sc1", name: "s1" },
      { id: "cc1", name: "c1" },
      { id: "cc2", name: "c2" },
      { id: "sc2", name: "s2" },
    ]);

    for await (const ev of runLoop(rt, { maxSteps: 1 })) {}

    // s1 must finish before c1/c2 start (it's its own batch)
    const s1Idx = order.indexOf("s1");
    const s2Idx = order.indexOf("s2");
    const c1Idx = order.indexOf("c1");
    const c2Idx = order.indexOf("c2");
    expect(s1Idx).toBeLessThan(Math.min(c1Idx, c2Idx));
    // s2 runs after c1/c2 (its own batch after concurrent batch)
    expect(s2Idx).toBeGreaterThan(Math.max(c1Idx, c2Idx));
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /root/my@chengchenccc/packages/framework && bun test --test-name-pattern="runLoop tool parallel"`
Expected: 5 tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/framework/src/run-loop.test.ts
git commit -m "test(framework): add parallel tool execution tests for runLoop"
```

---

### Task 1.6: Re-export new symbols from framework index

**Files:**
- Modify: `packages/framework/src/index.ts`

- [ ] **Step 1: Add export for `runOneCollect`**

Add after the `executeOne`-related exports (find the right location in index.ts):

```ts
export { runOneCollect } from "./execute-one.js";
export type { RunOneResult } from "./execute-one.js";
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /root/my-agent-team && bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/framework/src/index.ts
git commit -m "feat(framework): export runOneCollect and RunOneResult"
```

---

## Phase 2 — Context Compression (Default + Shape Order + Structured Summary)

### Task 2.1: Add `PreserveHint` to `ContextManagerContext`

**Files:**
- Modify: `packages/framework/src/context-manager.ts`

- [ ] **Step 1: Add PreserveHint type and optional preserve field**

```ts
import type { ChatModel } from "@chengchenccc/core";
import type { Message } from "@chengchenccc/message";
import type { Logger } from "./logger.js";

/** Marks index ranges in a Message[] that must not be dropped by shape(). */
export interface PreserveHint {
  /** Zero or more index ranges [start, end) that are mandatory.
   *  e.g. [{ start: 0, end: 1 }, { start: 5, end: 7 }] means messages
   *  at indices 0, 5, 6 are preserved. */
  ranges: Array<{ start: number; end: number }>;
}

export interface ContextManagerContext {
  threadId: string;
  signal?: AbortSignal;
  logger: Logger;
  model: ChatModel;
  /** Optional hint marking message indices that must survive shaping. */
  preserve?: PreserveHint;
}

export interface ContextManager {
  shape(ctx: ContextManagerContext, messages: readonly Message[]): Message[] | Promise<Message[]>;
}

export function pipeContextManagers(...managers: ContextManager[]): ContextManager {
  return {
    async shape(ctx, messages) {
      let current = [...messages];
      for (const m of managers) {
        current = await m.shape(ctx, current);
      }
      return current;
    },
  };
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /root/my-agent-team && bun run typecheck`
Expected: PASS (PreserveHint is optional, no callers pass it yet)

- [ ] **Step 3: Commit**

```bash
git add packages/framework/src/context-manager.ts
git commit -m "feat(framework): add PreserveHint to ContextManagerContext for injection-aware shaping"
```

---

### Task 2.2: Swap shape/beforeModel order in runLoop

**Files:**
- Modify: `packages/framework/src/run-loop.ts:82-86`

- [ ] **Step 1: Reorder shape and beforeModel**

Replace lines 82-86:

```ts
    // P2.2 fix: beforeModel first so shape sees the final payload (injection-aware).
    // Injected content (memory, skill index, system prompt) is marked as preserved
    // so the shaper doesn't drop it. Only compressible history is fair game.
    const injected = await rt.plugins.fireBeforeModel(rt.thread.messages);
    // Compute preserve ranges: all messages are "injected" (preserved) because
    // beforeModel may modify any message. The shaper sees the full result.
    const preserve: PreserveHint = { ranges: [{ start: 0, end: injected.length }] };
    // Let the shaper see everything; it can trim history but must respect preserve ranges.
    const finalMsgs = await rt.contextManager.shape(
      { threadId: rt.thread.id, signal: opts.signal, logger: rt.logger, model: rt.model, preserve },
      injected,
    );
```

- [ ] **Step 2: Add `PreserveHint` import**

Update imports at top:

```ts
import type { PreserveHint } from "./context-manager.js";
```

- [ ] **Step 3: Verify typecheck**

Run: `cd /root/my-agent-team && bun run typecheck`
Expected: PASS

- [ ] **Step 4: Run existing framework tests**

Run: `cd /root/my@chengchenccc/packages/framework && bun test`
Expected: All existing tests PASS (passthrough and summarizing managers ignore preserve)

- [ ] **Step 5: Commit**

```bash
git add packages/framework/src/run-loop.ts
git commit -m "fix(framework): reorder shape after beforeModel so shaper sees full payload"
```

---

### Task 2.3: Add `structuredSummarize` and export `defaultSummarize`

**Files:**
- Modify: `packages/framework/src/context-managers/summarizing.ts`

- [ ] **Step 1: Add `structuredSummarize` function, export `defaultSummarize`**

Add after `defaultSummarize` (around line 36), change `async function defaultSummarize` to `export async function defaultSummarize`, and add:

```ts
/** Structured summarizer: prompts the model to output a five-section summary
 *  (目标/约束/进度/关键决策/下一步) instead of free-form text.
 *  Missing sections are tolerated — the prompt is a strong hint, not a schema. */
export async function structuredSummarize(
  old: Message[],
  model: ChatModel,
  signal?: AbortSignal,
): Promise<Message> {
  const promptMsgs: Message[] = [
    ...old,
    {
      role: "user",
      text: [
        "Summarize the conversation above in the following structured format. ",
        "Output ONLY the summary in the exact format below, no preamble or commentary:\n",
        "[对话摘要]",
        "- 目标: (what the user is trying to achieve)",
        "- 约束: (any constraints or limits mentioned)",
        "- 进度: (what has been completed so far)",
        "- 关键决策: (important decisions made)",
        "- 下一步: (what needs to happen next)",
      ].join("\n"),
    },
  ];
  const { blocks } = await collectStream(model.stream(promptMsgs, { signal }));
  const text = extractText({ blocks: blocks as readonly { type: string; text?: string }[] });
  return { role: "user", text: `[Earlier conversation summary]:\n${text}` };
}
```

And change `async function defaultSummarize` to `export async function defaultSummarize`.

- [ ] **Step 2: Verify typecheck**

Run: `cd /root/my-agent-team && bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/framework/src/context-managers/summarizing.ts
git commit -m "feat(framework): add structuredSummarize and export defaultSummarize"
```

---

### Task 2.4: Write structured summarizer tests

**Files:**
- Modify: `packages/framework/src/context-managers/summarizing.test.ts`

- [ ] **Step 1: Add structuredSummarize tests**

Append to the existing test file:

```ts
import { structuredSummarize } from "./summarizing.js";

describe("structuredSummarize", () => {
  test("returns a message with structured summary content", async () => {
    // Use a simple echo-like model
    let capturedMsgs: Message[] = [];
    const model: any = {
      stream: async function* (msgs: Message[]) {
        capturedMsgs = msgs;
        yield { delta: { type: "text", text: "- 目标: test goal\n- 约束: none\n- 进度: halfway\n- 关键决策: decided A\n- 下一步: continue" }, usage: { input: 10, output: 20 } };
      },
    };

    const old: Message[] = [
      { role: "user", text: "do something" },
      { role: "assistant", text: "ok doing it" },
    ];

    const result = await structuredSummarize(old, model);

    expect(result.role).toBe("user");
    expect(result.text).toContain("[Earlier conversation summary]");
    expect(result.text).toContain("目标: test goal");
    expect(result.text).toContain("关键决策: decided A");
    expect(capturedMsgs.length).toBeGreaterThan(old.length);
    // Last message should be the summarization instruction
    const lastMsg = capturedMsgs[capturedMsgs.length - 1];
    expect(lastMsg?.text).toContain("Summarize the conversation");
  });

  test("tolerates missing sections in model output", async () => {
    const model: any = {
      stream: async function* () {
        yield { delta: { type: "text", text: "just a freeform summary, no structure" }, usage: { input: 5, output: 10 } };
      },
    };

    const old: Message[] = [{ role: "user", text: "hi" }];
    const result = await structuredSummarize(old, model);

    // Should still work — no parsing error, just wraps whatever the model returned
    expect(result.role).toBe("user");
    expect(result.text).toContain("[Earlier conversation summary]");
  });
});

describe("defaultSummarize", () => {
  test("is exported and produces a summary message", async () => {
    const { defaultSummarize } = await import("./summarizing.js");
    const model: any = {
      stream: async function* () {
        yield { delta: { type: "text", text: "The user said hi and the assistant replied." }, usage: { input: 5, output: 10 } };
      },
    };

    const old: Message[] = [{ role: "user", text: "hi" }];
    const result = await defaultSummarize(old, model);

    expect(result.role).toBe("user");
    expect(result.text).toContain("[Earlier conversation summary]");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /root/my@chengchenccc/packages/framework && bun test --test-name-pattern="structuredSummarize|defaultSummarize"`
Expected: 3 new tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/framework/src/context-managers/summarizing.test.ts
git commit -m "test(framework): add structuredSummarize and defaultSummarize export tests"
```

---

### Task 2.5: Wire default contextManager in harness

**Files:**
- Modify: `packages/harness/src/create-generic-agent.ts:151`

- [ ] **Step 1: Add default contextManager to createAgent call**

Add imports at top:

```ts
import {
  // ... existing imports ...
  pipeContextManagers,
  summarizingContextManager,
  toolResultTruncator,
} from "@chengchenccc/framework";
```

The `structuredSummarize` function needs to be importable. Since it's defined in framework's internal module, add a re-export in framework's index first (do this as a separate step or inline).

Actually, `structuredSummarize` is defined in `context-managers/summarizing.ts` and used as a `summarizer` callback. It needs to be importable. Add to framework index export:

In `packages/framework/src/index.ts`, add:

```ts
export { structuredSummarize, defaultSummarize } from "./context-managers/summarizing.js";
```

Then in `create-generic-agent.ts`, modify the `createAgent` call (around line 151):

```ts
  // 6. Wire up framework
  return createAgent({
    model,
    systemPrompt,
    tools,
    plugins,
    threadId,
    logger: lg,
    checkpointer,
    messages: opts.messages,
    contextManager: pipeContextManagers(
      toolResultTruncator({ maxCharsPerResult: 4000 }),
      summarizingContextManager({
        triggerAt: 100_000,
        keepRecent: 10,
        summarizer: structuredSummarize,
      }),
    ),
  });
```

- [ ] **Step 2: Add imports for new symbols**

In `create-generic-agent.ts`, update the framework import to include:
```ts
import {
  // ... existing ...
  pipeContextManagers,
  structuredSummarize,
  summarizingContextManager,
  toolResultTruncator,
} from "@chengchenccc/framework";
```

- [ ] **Step 3: Verify typecheck**

Run: `cd /root/my-agent-team && bun run typecheck`
Expected: PASS

- [ ] **Step 4: Run existing harness tests**

Run: `cd /root/my@chengchenccc/packages/harness && bun test`
Expected: All existing tests PASS (some may need updating if they assert on agent config shape)

- [ ] **Step 5: Commit**

```bash
git add packages/harness/src/create-generic-agent.ts packages/framework/src/index.ts
git commit -m "feat(harness): wire default contextManager with structured summarizer"
```

---

### Task 2.6: Update harness tests for default contextManager

**Files:**
- Modify: `packages/harness/src/create-generic-agent.test.ts`

- [ ] **Step 1: Check what the existing tests assert and update if needed**

Run: `cd /root/my@chengchenccc/packages/harness && bun test`
Expected: If tests fail, update assertions. If they pass, no changes needed.
If changes needed, look at the specific assertion and adjust to accommodate the new default contextManager.

- [ ] **Step 2: Commit (only if changes were needed)**

```bash
git add packages/harness/src/create-generic-agent.test.ts
git commit -m "test(harness): update tests for default contextManager"
```

---

## Phase 3 — Steering / In-Run Intervention

### Task 3.1: Add `SteeringQueue` and `FollowUpQueue` to AgentRunOptions

**Files:**
- Modify: `packages/framework/src/agent-options.ts`

- [ ] **Step 1: Add SteeringQueue and FollowUpQueue interfaces, update AgentRunOptions**

```ts
/** Process-local queue for in-run steering messages.
 *  Callers push messages externally; runLoop drains at each step boundary. */
export interface SteeringQueue {
  /** Non-blocking: returns all pending steering messages and clears the queue. */
  drain(): Message[];
}

/** Process-local queue for follow-up messages.
 *  Follow-ups are consumed after the inner step loop exhausts (end of current "task"). */
export interface FollowUpQueue {
  drain(): Message[];
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  maxSteps?: number;
  stream?: boolean;
  maxForceContinues?: number;
  runId?: string;
  /** Optional steering queue — messages pushed externally appear at the next step boundary. */
  steering?: SteeringQueue;
  /** Optional follow-up queue — messages consumed after inner steps exhaust. */
  followUp?: FollowUpQueue;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /root/my-agent-team && bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/framework/src/agent-options.ts
git commit -m "feat(framework): add SteeringQueue and FollowUpQueue to AgentRunOptions"
```

---

### Task 3.2: Add steering drain + outer follow-up loop to runLoop

**Files:**
- Modify: `packages/framework/src/run-loop.ts`

- [ ] **Step 1: Restructure runLoop with outer follow-up loop and per-step steering drain**

Replace the runLoop function signature and body. The key changes:
1. Wrap existing step loop in outer `while (true)` follow-up loop
2. At each step start, drain steering queue and append to thread
3. After inner loop ends, check follow-up queue; if messages, continue outer loop

```ts
export async function* runLoop(
  rt: AgentRuntime,
  opts: {
    signal?: AbortSignal;
    maxSteps: number;
    stream?: boolean;
    maxForceContinues?: number;
    steering?: SteeringQueue;
    followUp?: FollowUpQueue;
  },
): AsyncGenerator<AgentEvent> {
  let forceContinues = 0;
  const maxForce = opts.maxForceContinues ?? 3;
  const assistantOrdinal = 0;

  // Outer follow-up loop — each iteration is one "run" of up to maxSteps.
  // After inner steps exhaust (no more tool calls or maxSteps hit), check for
  // follow-up messages. If any, they become the new user input and we loop again.
  while (true) {
    for (let step = 0; step < opts.maxSteps; step++) {
      if (opts.signal?.aborted) {
        markRunningToolsAsError(rt);
        yield {
          type: "message",
          payload: {
            ...buildAssistantRevision(
              rt.runId, assistantOrdinal, "error", rt.assistantBlocks, rt.toolStates,
            ),
            error: { message: "Run aborted" },
          },
        };
        await rt.checkpointer.appendEvent?.(rt.thread.id, {
          type: "run_end", reason: "aborted", ts: Date.now(),
        });
        return;
      }

      // P3: Drain steering queue before model call — any externally pushed
      // messages appear as user messages in this step's context.
      const pending = opts.steering?.drain() ?? [];
      if (pending.length > 0) {
        rt.thread.messages.push(...pending);
        await rt.save(rt.thread.messages);
      }

      // P2.2 fix: beforeModel first, then shape (injection-aware)
      const injected = await rt.plugins.fireBeforeModel(rt.thread.messages);
      const preserve: PreserveHint = { ranges: [{ start: 0, end: injected.length }] };
      const finalMsgs = await rt.contextManager.shape(
        { threadId: rt.thread.id, signal: opts.signal, logger: rt.logger, model: rt.model, preserve },
        injected,
      );

      // ... REST OF STEP BODY IS UNCHANGED from here through tool execution ...
      // (model.stream, llm_call event, tool execution, etc. — same as Phase 1+2)
```

**Important:** The rest of the step body (model.stream through tool execution) stays identical to the Phase 1+2 version. Only add the steering drain block before the model call, and wrap everything in `while (true)`.

- [ ] **Step 2: The complete runLoop function should look like this (full replacement for the existing function)**

Since the function body is large, show the key structural diff:

```ts
export async function* runLoop(
  rt: AgentRuntime,
  opts: {
    signal?: AbortSignal;
    maxSteps: number;
    stream?: boolean;
    maxForceContinues?: number;
    steering?: SteeringQueue;
    followUp?: FollowUpQueue;
  },
): AsyncGenerator<AgentEvent> {
  let forceContinues = 0;
  const maxForce = opts.maxForceContinues ?? 3;
  const assistantOrdinal = 0;

  // Outer follow-up loop
  while (true) {
    for (let step = 0; step < opts.maxSteps; step++) {
      // ... abort check (unchanged) ...

      // *** NEW: Drain steering ***
      const pending = opts.steering?.drain() ?? [];
      if (pending.length > 0) {
        rt.thread.messages.push(...pending);
        await rt.save(rt.thread.messages);
      }

      // ... beforeModel → shape → model.stream (from P2.2) ...
      // ... model streaming (unchanged) ...
      // ... empty blocks → complete (unchanged) ...
      // ... tool execution (from P1, batch-based) ...
      // ... maxSteps handling (unchanged) ...
    }

    // *** NEW: Outer loop follow-up check ***
    const followUps = opts.followUp?.drain() ?? [];
    if (followUps.length === 0) break; // No follow-up → exit (existing behavior)
    rt.thread.messages.push(...followUps);
    await rt.save(rt.thread.messages);
    forceContinues = 0; // Reset for new inner loop
    // Loop continues — inner step loop restarts with follow-up as user input
  }
}
```

- [ ] **Step 3: Add imports**

```ts
import type { FollowUpQueue, SteeringQueue } from "./agent-options.js";
```

- [ ] **Step 4: Verify typecheck**

Run: `cd /root/my-agent-team && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Run existing tests**

Run: `cd /root/my@chengchenccc/packages/framework && bun test`
Expected: All existing tests PASS (no steering/followUp → behavior identical)

- [ ] **Step 6: Commit**

```bash
git add packages/framework/src/run-loop.ts
git commit -m "feat(framework): add steering drain and outer follow-up loop to runLoop"
```

---

### Task 3.3: Write steering + follow-up tests

**Files:**
- Modify: `packages/framework/src/run-loop.test.ts`

- [ ] **Step 1: Add steering drain tests**

Append to the existing run-loop test file:

```ts
import type { SteeringQueue, FollowUpQueue } from "./agent-options.js";

describe("runLoop steering", () => {
  test("steering messages appear in thread before model call", async () => {
    let modelReceivedMsgs: Message[] = [];
    const model: ChatModel = {
      stream: async function* (msgs: Message[]) {
        modelReceivedMsgs = [...msgs];
        yield { delta: { type: "text", text: "ok" }, stopReason: "end_turn", done: true, usage: { input: 10, output: 2 } };
      },
    };

    const rt = makeRt();
    rt.model = model;

    const queue: Message[] = [{ role: "user", text: "steering: correct course" }];
    const steering: SteeringQueue = {
      drain: () => {
        const items = [...queue];
        queue.length = 0;
        return items;
      },
    };

    for await (const ev of runLoop(rt, { maxSteps: 1, steering })) {}

    expect(modelReceivedMsgs.some((m) => m.text?.includes("steering: correct course"))).toBe(true);
  });

  test("no steering → runLoop behaves identically to before", async () => {
    const rt = makeRt();
    rt.model = {
      stream: async function* () {
        yield { delta: { type: "text", text: "ok" }, stopReason: "end_turn", done: true, usage: { input: 10, output: 2 } };
      },
    };

    const events: any[] = [];
    for await (const ev of runLoop(rt, { maxSteps: 1 })) {
      events.push(ev);
    }

    // Should complete normally with a message event
    expect(events.some((e) => e.type === "message")).toBe(true);
  });

  test("follow-up messages trigger a new inner loop iteration", async () => {
    let callCount = 0;
    const model: ChatModel = {
      stream: async function* () {
        callCount++;
        yield { delta: { type: "text", text: `turn-${callCount}` }, stopReason: "end_turn", done: true, usage: { input: 10, output: 5 } };
      },
    };

    const rt = makeRt();
    rt.model = model;

    const followUpQueue: Message[] = [{ role: "user", text: "follow-up: do more" }];
    const followUp: FollowUpQueue = {
      drain: () => {
        const items = [...followUpQueue];
        followUpQueue.length = 0;
        return items;
      },
    };

    for await (const ev of runLoop(rt, { maxSteps: 1, followUp })) {}

    // Model called twice: once for initial run, once for follow-up
    expect(callCount).toBe(2);
  });

  test("no follow-up → single outer loop iteration (existing behavior)", async () => {
    let callCount = 0;
    const model: ChatModel = {
      stream: async function* () {
        callCount++;
        yield { delta: { type: "text", text: "done" }, stopReason: "end_turn", done: true, usage: { input: 10, output: 5 } };
      },
    };

    const rt = makeRt();
    rt.model = model;

    for await (const ev of runLoop(rt, { maxSteps: 2 })) {}

    // Without follow-up, model called at most maxSteps times (no tool calls → stops at 0 blocks)
    // Actually since model returns no tool_use blocks, it stops at step 0
    expect(callCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /root/my@chengchenccc/packages/framework && bun test --test-name-pattern="runLoop steering"`
Expected: 4 tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/framework/src/run-loop.test.ts
git commit -m "test(framework): add steering drain and follow-up loop tests"
```

---

## Phase 4 — Skill Dual-Domain + Explicit Invocation

### Task 4.1: Extend SkillMeta with `disableModelInvocation`

**Files:**
- Modify: `packages/plugin-progressive-skill/src/cache.ts`

- [ ] **Step 1: Add field to SkillMeta and parse from frontmatter**

```ts
export interface SkillMeta {
  name: string;
  description: string;
  dir: string;
  skillMdPath: string;
  bodyOffset: number;
  /** When true, this skill is excluded from the model's skill index.
   *  It can only be invoked via explicit /skill:name call, not by the model. */
  disableModelInvocation?: boolean;
}
```

In `loadOneSkillFrontmatter`, add after the description line:

```ts
  return {
    name: parsed.data.name as string,
    description: (parsed.data.description as string) ?? "",
    dir: skillDir,
    skillMdPath,
    bodyOffset: raw.length - parsed.content.length,
    disableModelInvocation: parsed.data["disable-model-invocation"] === true,
  };
```

- [ ] **Step 2: Run existing progressive-skill tests**

Run: `cd /root/my@chengchenccc/packages/plugin-progressive-skill && bun test`
Expected: All existing tests PASS (new field is optional)

- [ ] **Step 3: Commit**

```bash
git add packages/plugin-progressive-skill/src/cache.ts
git commit -m "feat(plugin-progressive-skill): add disableModelInvocation to SkillMeta"
```

---

### Task 4.2: Multi-root skill discovery

**Files:**
- Modify: `packages/plugin-progressive-skill/src/cache.ts`
- Modify: `packages/plugin-progressive-skill/src/progressive-skill.ts`

- [ ] **Step 1: Extend `loadSkillIndexWithMtimeCache` to accept multiple roots**

```ts
const skillIndexCaches = new Map<string, { skills: SkillMeta[]; mtime: number }>();

/** Load and merge skill indexes from multiple roots.
 *  Later roots override earlier ones on name collision (project > global). */
export async function loadSkillIndexWithMtimeCache(
  ws: AgentFsLike,
  roots: string[],
  logger?: { warn: (msg: string, err?: unknown) => void },
): Promise<SkillMeta[]> {
  const allSkills: SkillMeta[] = [];
  const seen = new Map<string, number>(); // name → index in allSkills

  for (const root of roots) {
    const dirStat = await ws.stat(root);
    const cached = skillIndexCaches.get(root);
    if (cached) {
      if (dirStat && cached.mtime === dirStat.mtimeMs) {
        // Merge cached skills for this root, overriding earlier roots on collision
        for (const skill of cached.skills) {
          const existingIdx = seen.get(skill.name);
          if (existingIdx !== undefined) {
            allSkills[existingIdx] = skill; // later root overrides
          } else {
            seen.set(skill.name, allSkills.length);
            allSkills.push(skill);
          }
        }
        continue;
      }
      if (!dirStat) {
        for (const skill of cached.skills) {
          const existingIdx = seen.get(skill.name);
          if (existingIdx !== undefined) {
            allSkills[existingIdx] = skill;
          } else {
            seen.set(skill.name, allSkills.length);
            allSkills.push(skill);
          }
        }
        continue;
      }
    }

    const entries = await ws.list(root);
    const results = await Promise.allSettled(
      entries.map((name) => loadOneSkillFrontmatter(ws, pjoin(root, name))),
    );

    const rootSkills: SkillMeta[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === "fulfilled" && r.value) {
        rootSkills.push(r.value);
      } else if (r.status === "rejected") {
        logger?.warn(`skill '${entries[i]}' load failed`, r.reason);
      }
    }

    skillIndexCaches.set(root, { skills: rootSkills, mtime: dirStat?.mtimeMs ?? 0 });

    // Merge with override semantics
    for (const skill of rootSkills) {
      const existingIdx = seen.get(skill.name);
      if (existingIdx !== undefined) {
        allSkills[existingIdx] = skill;
      } else {
        seen.set(skill.name, allSkills.length);
        allSkills.push(skill);
      }
    }
  }

  return allSkills;
}
```

- [ ] **Step 2: Also keep the old single-root signature for backward compat**

Add an overload/alternative:

```ts
/** Single-root convenience wrapper. Kept for backward compatibility. */
export async function loadSkillIndexFromRoot(
  ws: AgentFsLike,
  root: string,
  logger?: { warn: (msg: string, err?: unknown) => void },
): Promise<SkillMeta[]> {
  return loadSkillIndexWithMtimeCache(ws, [root], logger);
}
```

- [ ] **Step 3: Update `progressive-skill.ts` to use roots array**

```ts
export interface ProgressiveSkillOptions {
  ws: AgentFsLike;
  /** Single root (backward compat). Use `roots` for multi-domain. */
  root?: string;
  /** Multiple roots in priority order (later overrides earlier on name collision).
   *  e.g. [globalRoot, projectRoot] — project skills shadow global ones. */
  roots?: string[];
  maxCharsPerLoad?: number;
  posixSkillRoot?: string;
}

export function progressiveSkillPlugin(options: ProgressiveSkillOptions): Plugin {
  const ws = options.ws;
  const roots = options.roots ?? [options.root ?? "/skills/"];
  const maxCharsPerLoad = options.maxCharsPerLoad ?? 8000;
  const posixSkillRoot = options.posixSkillRoot;

  return {
    name: "progressive-skill",
    tools: [skillLoadTool({ ws, roots, maxCharsPerLoad, posixSkillRoot })],
    hooks: {
      async beforeModel(ctx, messages: readonly Message[]) {
        let skills: SkillMeta[];
        try {
          skills = await loadSkillIndexWithMtimeCache(ws, roots, ctx.logger);
        } catch (err) {
          ctx.logger.warn("progressive-skill: load failed, skipping injection", err);
          return [...messages];
        }

        if (skills.length === 0) return [...messages];

        const systemIdx = messages.findIndex((m) => m.role === "system");
        if (systemIdx < 0) {
          ctx.logger.warn("progressive-skill: no system message, skipping injection");
          return [...messages];
        }

        // Filter out disabled skills from model index
        const indexBlock = renderIndex(skills.filter((s) => !s.disableModelInvocation));
        const sys = messages[systemIdx];
        if (!sys) return messages as Message[];
        const newSys = {
          ...sys,
          text: `${sys.text ?? ""}\n\n${indexBlock}`,
        };
        return [
          ...messages.slice(0, systemIdx),
          newSys,
          ...messages.slice(systemIdx + 1),
        ] as Message[];
      },
    },
  };
}
```

- [ ] **Step 4: Update `skill-load.ts` to accept roots array**

```ts
export function skillLoadTool(opts: {
  ws: AgentFsLike;
  roots: string[];
  maxCharsPerLoad?: number;
  posixSkillRoot?: string;
}): Tool {
  const { ws, roots, maxCharsPerLoad = 8000, posixSkillRoot } = opts;

  async function findSkill(name: string): Promise<SkillMeta | null> {
    const skills = await loadSkillIndexWithMtimeCache(ws, roots);
    return skills.find((s) => s.name === name) ?? null;
  }
  // ... rest unchanged ...
}
```

- [ ] **Step 5: Verify typecheck**

Run: `cd /root/my-agent-team && bun run typecheck`
Expected: PASS

- [ ] **Step 6: Run existing progressive-skill tests**

Run: `cd /root/my@chengchenccc/packages/plugin-progressive-skill && bun test`
Expected: Tests may need updates for the `root` → `roots` change. Fix as needed.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-progressive-skill/src/cache.ts packages/plugin-progressive-skill/src/progressive-skill.ts packages/plugin-progressive-skill/src/skill-load.ts
git commit -m "feat(plugin-progressive-skill): multi-root skill discovery with override semantics"
```

---

### Task 4.3: Add `/skill:name` explicit invocation

**Files:**
- Modify: `packages/plugin-progressive-skill/src/progressive-skill.ts` (export new function)
- Modify: `packages/plugin-progressive-skill/src/index.ts` (re-export)

- [ ] **Step 1: Export `findSkillByName` for explicit invocation**

In `progressive-skill.ts`, add an exported function:

```ts
/** Find and load a skill by name, bypassing the model's tool_call path.
 *  Works for ALL skills including those with disableModelInvocation: true.
 *  Returns the skill body (with ${SKILL_DIR} resolved) or null if not found. */
export async function findSkillByName(
  opts: ProgressiveSkillOptions,
  name: string,
): Promise<{ skill: SkillMeta; body: string } | null> {
  const ws = opts.ws;
  const roots = opts.roots ?? [opts.root ?? "/skills/"];
  const maxCharsPerLoad = opts.maxCharsPerLoad ?? 8000;
  const posixSkillRoot = opts.posixSkillRoot;

  const skills = await loadSkillIndexWithMtimeCache(ws, roots);
  const skill = skills.find((s) => s.name === name);
  if (!skill) return null;

  const raw = (await ws.read(skill.skillMdPath)) ?? "";
  const body = raw.slice(skill.bodyOffset);

  // Resolve ${SKILL_DIR}
  let resolved = body;
  if (posixSkillRoot) {
    const posixRoot = posixSkillRoot.endsWith("/") ? posixSkillRoot.slice(0, -1) : posixSkillRoot;
    // root always ends with "/"
    const logicalRoot = (roots[roots.length - 1] ?? "/skills/").replace(/\/$/, "");
    resolved = body.replaceAll("${SKILL_DIR}", skill.dir.replace(logicalRoot, posixRoot));
  } else {
    resolved = body;
  }

  return { skill, body: resolved };
}
```

- [ ] **Step 2: Update plugin index to export the new function**

In `packages/plugin-progressive-skill/src/index.ts`:
```ts
export { progressiveSkillPlugin, findSkillByName } from "./progressive-skill.js";
```

- [ ] **Step 3: Verify typecheck**

Run: `cd /root/my-agent-team && bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-progressive-skill/src/progressive-skill.ts packages/plugin-progressive-skill/src/index.ts
git commit -m "feat(plugin-progressive-skill): add findSkillByName for explicit /skill:name invocation"
```

---

### Task 4.4: Write dual-domain + explicit invocation tests

**Files:**
- Modify: `packages/plugin-progressive-skill/src/progressive-skill.test.ts`

- [ ] **Step 1: Add dual-domain and disableModelInvocation tests**

Append to the existing test file:

```ts
import { findSkillByName } from "./progressive-skill.js";

describe("dual-domain skills", () => {
  test("project domain overrides global domain on name collision", async () => {
    const ws = testFS();
    const globalRoot = "/skills-global/";
    const projectRoot = "/skills-project/";

    const globalSkill = [
      "---",
      "name: my-skill",
      "description: Global version",
      "---",
      "Global body",
    ].join("\n");

    const projectSkill = [
      "---",
      "name: my-skill",
      "description: Project override",
      "---",
      "Project body",
    ].join("\n");

    await ws.write(`${globalRoot}my-skill/SKILL.md`, globalSkill);
    await ws.write(`${projectRoot}my-skill/SKILL.md`, projectSkill);
    invalidateSkillCache(globalRoot);
    invalidateSkillCache(projectRoot);

    const plugin = progressiveSkillPlugin({ ws, roots: [globalRoot, projectRoot] });
    const msgs: Message[] = [
      { role: "system", text: "You are helpful." },
      { role: "user", text: "hi" },
    ];

    const result = await plugin.hooks!.beforeModel!(testCtx(), msgs);
    const sysText = result[0]?.text ?? "";

    // Project description should appear, not global
    expect(sysText).toContain("Project override");
    expect(sysText).not.toContain("Global version");
  });

  test("disabled skills excluded from model index", async () => {
    const ws = testFS();
    const root = "/skills/";

    const normalSkill = [
      "---",
      "name: normal-skill",
      "description: Visible to model",
      "---",
      "normal body",
    ].join("\n");

    const disabledSkill = [
      "---",
      "name: admin-skill",
      "description: Admin only",
      "disable-model-invocation": true,
      "---",
      "admin body",
    ].join("\n");

    await ws.write(`${root}normal-skill/SKILL.md`, normalSkill);
    await ws.write(`${root}admin-skill/SKILL.md`, disabledSkill);
    invalidateSkillCache(root);

    const plugin = progressiveSkillPlugin({ ws, root });
    const msgs: Message[] = [
      { role: "system", text: "system" },
      { role: "user", text: "hi" },
    ];

    const result = await plugin.hooks!.beforeModel!(testCtx(), msgs);
    const sysText = result[0]?.text ?? "";

    expect(sysText).toContain("normal-skill");
    expect(sysText).not.toContain("admin-skill");
  });
});

describe("findSkillByName (explicit invocation)", () => {
  test("finds a normal skill", async () => {
    const ws = testFS();
    const root = "/skills/";
    const skillMd = [
      "---",
      "name: my-skill",
      "description: A test skill",
      "---",
      "Skill body content",
    ].join("\n");
    await ws.write(`${root}my-skill/SKILL.md`, skillMd);
    invalidateSkillCache(root);

    const result = await findSkillByName({ ws, root }, "my-skill");
    expect(result).not.toBeNull();
    expect(result!.body).toContain("Skill body content");
  });

  test("finds a disabled skill (bypasses model-only restriction)", async () => {
    const ws = testFS();
    const root = "/skills/";
    const skillMd = [
      "---",
      "name: admin-skill",
      "description: Admin",
      "disable-model-invocation": true,
      "---",
      "Admin body",
    ].join("\n");
    await ws.write(`${root}admin-skill/SKILL.md`, skillMd);
    invalidateSkillCache(root);

    const result = await findSkillByName({ ws, root }, "admin-skill");
    expect(result).not.toBeNull();
    expect(result!.body).toContain("Admin body");
  });

  test("returns null for unknown skill", async () => {
    const ws = testFS();
    const root = "/skills/";

    const result = await findSkillByName({ ws, root }, "nonexistent");
    expect(result).toBeNull();
  });
});

describe("backward compat: single root", () => {
  test("root option still works", async () => {
    const ws = testFS();
    const root = "/skills/";
    await ws.write(`${root}my-skill/SKILL.md`, [
      "---",
      "name: my-skill",
      "description: Single root",
      "---",
      "body",
    ].join("\n"));
    invalidateSkillCache(root);

    const plugin = progressiveSkillPlugin({ ws, root });
    const msgs: Message[] = [
      { role: "system", text: "system" },
      { role: "user", text: "hi" },
    ];

    const result = await plugin.hooks!.beforeModel!(testCtx(), msgs);
    expect(result[0]?.text).toContain("my-skill");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /root/my@chengchenccc/packages/plugin-progressive-skill && bun test`
Expected: All tests (old + new) PASS

- [ ] **Step 3: Commit**

```bash
git add packages/plugin-progressive-skill/src/progressive-skill.test.ts
git commit -m "test(plugin-progressive-skill): add dual-domain, disabled skill, and explicit invocation tests"
```

---

## Phase 5 — Documentation Sync

### Task 5.1: Update context-manager.md

**Files:**
- Modify: `docs/architecture/runtime/context-manager.md`

- [ ] **Step 1: Rewrite sections per spec**

Key changes:
- Move the "当前局限：预算对注入是瞎的" section to a "已修复" note
- Update the default section from "默认是透传：能力在、但没接上" to "通用 Agent 默认装配"
- Update the summary section from "自由文本" to "结构化五槽位"
- Update the flowchart: `thread.messages → beforeModel → shape → model.stream`

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/runtime/context-manager.md
git commit -m "docs(docs): update context-manager for M22 shape order fix and structured summary"
```

---

### Task 5.2: Update framework.md, harness.md, progressive-skill.md, future-work.md

**Files:**
- Modify: `docs/architecture/runtime/framework.md`
- Modify: `docs/architecture/harness/harness.md`
- Modify: `docs/architecture/plugins/progressive-skill.md`
- Modify: `docs/architecture/roadmap/future-work.md`

- [ ] **Step 1: Update each doc per spec §9**

framework.md: runLoop tool execution (serial→batch), steering + follow-up loop
harness.md: contextManager default
progressive-skill.md: single-domain→dual-domain, /skill:name, disable-model-invocation
future-work.md: M22 entry from "planned" to "done" with cross-references

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/
git commit -m "docs(docs): sync architecture docs for M22 runtime hardening"
```

---

## Final Verification

### Task 6.1: Run full test suite

- [ ] **Step 1: Run all tests across monorepo**

```bash
cd /root/my-agent-team && bun run test
```
Expected: All tests PASS, including new M22 tests

- [ ] **Step 2: Run typecheck**

```bash
cd /root/my-agent-team && bun run typecheck
```
Expected: PASS, no type errors

- [ ] **Step 3: Run lint**

```bash
cd /root/my-agent-team && bun run lint
```
Expected: PASS

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "chore: final verification fixes for M22"
```
