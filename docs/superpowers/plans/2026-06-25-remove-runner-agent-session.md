# Remove Runner & AgentFS, Integrate AgentSession — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the runner process boundary (runner-daemon, runner-protocol, RunnerRegistry, transport routing) and AgentFS abstraction, replace with AgentSession orchestrating Agent + Checkpointer + PluginRunner + ContextManager directly in the backend process.

**Architecture:** AgentSession is a new harness-level class that wraps Agent with retry/compaction/event-subscription. Backend creates AgentSession directly (no child process), injects ConversationContextPlugin (tools + systemPrompt built by backend), and listens to events via `session.subscribe()`. Tools use plain `cwd` paths instead of AgentFsLike.

**Tech Stack:** TypeScript ESM, bun test, Biome lint/format, drizzle-orm + bun:sqlite

**Spec:** `docs/superpowers/specs/2026-06-25-remove-runner-agent-session-design.md`

---

## File Structure Map

```
NEW FILES (Phase 1):
  packages/harness/src/agent-session.ts           — AgentSession class
  packages/harness/src/compaction.ts              — compaction logic + reflectionGuidance
  packages/harness/src/plugins/identity-plugin.ts  — identityPlugin (from bootstrap)
  packages/tools-common/src/file-tools.ts          — cwd-based read/write/edit tools

MODIFIED FILES (Phase 1):
  packages/framework/src/create-agent.ts           — add subscribe()
  packages/framework/src/agent-options.ts          — add AgentEventListener type
  packages/framework/src/index.ts                  — add autoSummarize export
  packages/framework/src/context-managers/summarizing.ts — rename export
  packages/framework/src/context-managers/index.ts — rename re-export
  packages/harness/src/index.ts                    — add new exports
  packages/tools-common/src/index.ts               — add cwd tool exports
  packages/plugin-fs-memory/src/fs-memory.ts       — AgentFsLike → cwd
  packages/plugin-fs-memory/src/memory-read.ts     — AgentFsLike → cwd
  packages/plugin-fs-memory/src/memory-write.ts    — AgentFsLike → cwd
  packages/plugin-fs-memory/src/memory-search.ts   — AgentFsLike → cwd
  packages/plugin-fs-memory/src/cache.ts           — AgentFsLike → cwd
  packages/plugin-fs-memory/src/frontmatter.ts     — AgentFsLike → cwd
  packages/plugin-progressive-skill/src/progressive-skill.ts — AgentFsLike → cwd
  packages/plugin-progressive-skill/src/skill-load.ts       — AgentFsLike → cwd
  packages/plugin-progressive-skill/src/cache.ts            — AgentFsLike → cwd

MODIFIED FILES (Phase 2):
  packages/message/src/revision.ts                 — add runStatus field
  apps/backend/src/features/conversation/conv-tools.ts — NEW: conversation tools
  apps/backend/src/features/conversation/conv-svc-factory.ts — AgentSession integration
  apps/backend/src/features/conversation/projection.ts — delete buildPreloadedMessages
  apps/backend/src/features/conversation/service.ts — remove threadProjectionWrite
  apps/backend/src/features/run/supervisor.ts       — degrade to RunLifecycleTracker
  apps/backend/src/features/run/service.ts          — use AgentSession
  apps/backend/src/features/run/dispatcher.ts       — absorb into startAgentRun
  apps/backend/src/features/agent/agent-svc-factory.ts — simplify workspace
  apps/backend/src/features/agent/identity-store.ts — agents/{id} paths
  apps/backend/src/features/runtime-ops/types.ts    — remove RunnerHealthRow
  apps/backend/src/features/runtime-ops/store.ts    — remove runner_health ops
  apps/backend/src/features/runtime-ops/service.ts  — remove runner queries
  apps/backend/src/main.ts                          — AgentSession wiring
  apps/backend/src/http/router.ts                   — remove threadProjection
  apps/web/src/lib/conversation-reducer.ts          — runStatus handling
  apps/web/src/lib/api.ts                           — remove runner types
  apps/web/src/lib/ops-diagnosis.ts                 — remove runner diagnosis
  apps/web/src/components/MessageBubble.tsx          — runStatus indicators
  apps/web/src/components/ConversationCanvas.tsx     — runStatus status labels
  apps/web/src/components/ops/*.tsx                 — remove runner UI (18 files)

DELETED FILES (Phase 3):
  packages/runner-protocol/                         — entire package
  packages/runner-daemon/                           — entire package
  packages/agent-fs/                                — entire package
  packages/harness/src/create-generic-agent.ts
  packages/harness/src/bootstrap.ts
  packages/harness/src/reflect.ts
  packages/core/src/agent-fs.ts
  packages/tools-common/src/sandbox.ts
  packages/tools-common/src/agent-fs-like.ts
  packages/tools-common/src/afs-tools.ts
  apps/backend/src/features/run/runner-registry.ts
  apps/backend/src/features/run/runner-registry-factory.ts
  apps/backend/src/features/run/dispatcher.ts
  apps/backend/src/features/thread-projection/     — 6 files
  apps/backend/src/infra/runner-workspace.ts
  apps/web/src/lib/run-status.ts
  apps/web/src/components/ops/AgentRuntimeCard.tsx (runner block only, keep surface)
```

---

## Phase 1: Add new APIs, keep old (no breakage)

### Task 1: Framework — Agent.subscribe()

**Files:**
- Modify: `packages/framework/src/agent-options.ts`
- Modify: `packages/framework/src/create-agent.ts`
- Modify: `packages/framework/src/run-loop.ts`

- [ ] **Step 1: Add AgentEventListener type and subscribe() to Agent interface**

In `packages/framework/src/agent-options.ts`, add after the existing `Agent` interface:

```typescript
import type { AgentEvent } from "./agent-event.js";

export type AgentEventListener = (event: AgentEvent) => void;

// Inside Agent interface, add:
  /** Subscribe to agent events. Returns unsubscribe function. */
  subscribe(listener: AgentEventListener): () => void;
```

- [ ] **Step 2: Modify AgentRuntime to hold subscribers**

In `packages/framework/src/agent-options.ts`, add to `AgentRuntime`:

```typescript
  subscribers: Set<AgentEventListener>;
```

- [ ] **Step 3: Modify createAgentInternal to initialize subscribers and implement subscribe()**

In `packages/framework/src/create-agent.ts`, in `createAgentInternal()`:

After `const rt: AgentRuntime = { ... }` initialization, ensure `subscribers: new Set()` is included.

In the returned `Agent` object, add:

```typescript
    subscribe(listener: AgentEventListener): () => void {
      rt.subscribers.add(listener);
      return () => { rt.subscribers.delete(listener); };
    },
```

- [ ] **Step 4: Modify runLoop to notify subscribers on yield**

In `packages/framework/src/run-loop.ts`, accept subscribers as a new option. After each `yield event`, notify:

```typescript
// In runLoop opts, add:
  subscribers?: Set<AgentEventListener>;

// After each yield, add:
  if (opts.subscribers) {
    for (const sub of opts.subscribers) sub(event);
  }
```

Note: subscribers are notified AFTER yield (so the generator consumer gets the event first, then subscribers).

- [ ] **Step 5: Pass subscribers through createAgentInternal → runLoop**

In `create-agent.ts`, update the `#run` helper to accept and pass subscribers. In the internal `createRunGenerator` that wraps `runLoop`, pass `rt.subscribers`:

```typescript
    const generator = runLoop(rt, {
      signal: opts.signal,
      maxSteps: opts.maxSteps ?? 50,
      stream: opts.stream ?? true,
      maxForceContinues: opts.maxForceContinues,
      steering: opts.steering,
      followUp: opts.followUp,
      subscribers: rt.subscribers,   // NEW
    });
```

- [ ] **Step 6: Add test for Agent.subscribe()**

In `packages/framework/src/create-agent.test.ts` (or a new test file), add:

```typescript
import { describe, test, expect } from "bun:test";
import { createAgent } from "./create-agent.js";
import { echoModel } from "@chengchenccc/test-helpers";

describe("Agent.subscribe()", () => {
  test("notifies subscriber on each event", async () => {
    const model = echoModel([{ text: "hello" }]);
    const agent = await createAgent({ model });
    const events: string[] = [];
    const unsub = agent.subscribe((e) => events.push(e.type));

    const results = [];
    for await (const ev of agent.run([{ role: "user", text: "hi" }])) {
      results.push(ev);
    }

    unsub();
    expect(events.length).toBeGreaterThan(0);
    expect(events).toContain("message");
  });

  test("unsubscribe stops notifications", async () => {
    const model = echoModel([{ text: "hello" }]);
    const agent = await createAgent({ model });
    const events: string[] = [];
    const unsub = agent.subscribe((e) => events.push(e.type));
    unsub();

    for await (const _ of agent.run([{ role: "user", text: "hi" }])) {
      // drain
    }

    expect(events.length).toBe(0);
  });
});
```

- [ ] **Step 7: Run tests and commit**

```bash
cd packages/framework && bun test --test-name-pattern="subscribe"
```

Expected: tests pass.

```bash
git add packages/framework/src/agent-options.ts packages/framework/src/create-agent.ts packages/framework/src/run-loop.ts
git commit -m "feat(framework): add Agent.subscribe() for event listeners"
```

---

### Task 2: Framework — autoSummarize rename

**Files:**
- Modify: `packages/framework/src/context-managers/summarizing.ts`
- Modify: `packages/framework/src/context-managers/index.ts`
- Modify: `packages/framework/src/index.ts`

- [ ] **Step 1: Add autoSummarize as new export name, keep old**

In `packages/framework/src/context-managers/summarizing.ts`, add at the bottom:

```typescript
/** @deprecated Use autoSummarize instead */
export const summarizingContextManager = (opts: SummarizingOptions): ContextManager => {
  return autoSummarize(opts);
};
```

And rename the main export function from `summarizingContextManager` to `autoSummarize`:

```typescript
export function autoSummarize(opts: SummarizingOptions): ContextManager {
  // ... existing implementation (unchanged)
}
```

The old name `summarizingContextManager` becomes a deprecated wrapper that calls `autoSummarize`.

- [ ] **Step 2: Update framework barrel exports**

In `packages/framework/src/index.ts`, duplicate the export line:

```typescript
export {
  autoSummarize,
  defaultSummarize,
  structuredSummarize,
  summarizingContextManager,  // @deprecated — use autoSummarize
} from "./context-managers/summarizing.js";
export type { SummarizingOptions } from "./context-managers/summarizing.js";
```

- [ ] **Step 3: Run typecheck and existing tests**

```bash
cd packages/framework && bun run typecheck && bun test
```

Expected: all existing tests pass, no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/framework/src/context-managers/summarizing.ts packages/framework/src/index.ts
git commit -m "refactor(framework): rename summarizingContextManager to autoSummarize (old name kept as deprecated)"
```

---

### Task 3: Harness — AgentSession class

**Files:**
- Create: `packages/harness/src/agent-session.ts`

- [ ] **Step 1: Create AgentSessionEvent types**

Write `packages/harness/src/agent-session.ts`:

```typescript
import type { Agent, AgentEvent, AgentEventListener, Checkpointer, ContextManager, Logger, Plugin } from "@chengchenccc/framework";
import type { ChatModel, Tool } from "@chengchenccc/core";
import type { Message } from "@chengchenccc/message";

// ─── Types ───────────────────────────────────────────────

export type ThinkingLevel = "low" | "medium" | "high";

export interface RetrySettings {
  maxAttempts: number;
  backoffMs: number;
}

export interface CompactionSettings {
  autoCompact?: boolean;
  triggerAtTokens?: number;
  keepRecent?: number;
}

export interface AgentSessionConfig {
  // framework passthrough
  model: ChatModel;
  threadId?: string;
  tools?: Tool[];
  plugins?: Plugin[];
  checkpointer?: Checkpointer;
  contextManager?: ContextManager;
  logger?: Logger;

  // session layer
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  maxSteps?: number;
  retry?: RetrySettings;
  compaction?: CompactionSettings;
}

export interface CompactionResult {
  originalCount: number;
  compactedCount: number;
  summaryLength: number;
}

export interface ToolInfo {
  name: string;
  description: string;
}

export type AgentState = "idle" | "running" | "compacting" | "retrying" | "done" | "error";

export interface ContextUsage {
  totalTokens?: number;
  messageCount: number;
}

// Session-level events — extends AgentEvent with session lifecycle
export type AgentSessionEvent =
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: Message[]; willRetry: boolean }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result?: CompactionResult; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

export type SessionEventListener = (event: AgentSessionEvent) => void;

// ─── AgentSession ────────────────────────────────────────

export class AgentSession {
  #agent!: Agent;
  #config: AgentSessionConfig;
  #state: AgentState = "idle";
  #subscribers = new Set<SessionEventListener>();
  #abortController: AbortController | null = null;
  #steeringQueue: string[] = [];
  #followUpQueue: string[] = [];
  #lastError: string | null = null;
  #retryCount = 0;
  #unsubAgent: (() => void) | null = null;

  constructor(config: AgentSessionConfig) {
    this.#config = {
      maxSteps: 50,
      retry: { maxAttempts: 3, backoffMs: 2000 },
      compaction: { autoCompact: true, triggerAtTokens: 100_000, keepRecent: 10 },
      ...config,
    };
  }

  // ─── Public getters ──────────────────────────────────

  get state(): AgentState { return this.#state; }
  get isStreaming(): boolean { return this.#state === "running"; }

  // ─── Lifecycle ───────────────────────────────────────

  async prompt(text: string, opts?: { signal?: AbortSignal }): Promise<void> {
    if (this.#state === "running") {
      this.#followUpQueue.push(text);
      this.#emit({ type: "queue_update", steering: [...this.#steeringQueue], followUp: [...this.#followUpQueue] });
      return;
    }

    // Initialize agent on first prompt
    if (!this.#agent) {
      await this.#initAgent();
    }

    await this.#runLoop([{ role: "user", text }], opts);
  }

  async continue(opts?: { signal?: AbortSignal }): Promise<void> {
    await this.#runLoop(undefined, opts);
  }

  async resume(cmd: { approved: boolean; message?: string }, opts?: { signal?: AbortSignal }): Promise<void> {
    if (!this.#agent) throw new Error("Agent not initialized");
    const signal = this.#combineSignal(opts?.signal);
    try {
      for await (const _ of this.#agent.resume(cmd, { signal })) {
        // events handled by agent subscriber
      }
    } catch (err) {
      this.#handleError(err, "resume");
    }
  }

  abort(): void {
    this.#abortController?.abort();
  }

  async waitForIdle(): Promise<void> {
    while (this.#state === "running" || this.#state === "compacting" || this.#state === "retrying") {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  dispose(): void {
    this.#unsubAgent?.();
    this.#subscribers.clear();
    this.#abortController?.abort();
  }

  // ─── Runtime interventions ───────────────────────────

  steer(text: string): void {
    if (this.#state === "running") {
      this.#steeringQueue.push(text);
    } else {
      // queue for next run
    }
  }

  followUp(text: string): void {
    this.#followUpQueue.push(text);
  }

  // ─── Configuration ───────────────────────────────────

  setModel(model: ChatModel): void {
    this.#config.model = model;
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.#config.thinkingLevel = level;
  }

  setActiveTools(toolNames: string[]): void {
    // Rebuild agent with filtered tools — for now, no-op
    // Future: reconfigure agent tools at runtime
  }

  getAllTools(): ToolInfo[] {
    if (!this.#agent) return [];
    // Tools are on the agent config — we don't expose them directly yet
    return [];
  }

  // ─── Maintenance ─────────────────────────────────────

  async compact(customInstructions?: string): Promise<CompactionResult> {
    this.#emit({ type: "compaction_start", reason: "manual" });
    // Stub — full implementation in Task 4
    const result: CompactionResult = { originalCount: 0, compactedCount: 0, summaryLength: 0 };
    this.#emit({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
    return result;
  }

  getContextUsage(): ContextUsage | undefined {
    return this.#agent ? { messageCount: this.#agent.thread.messages.length } : undefined;
  }

  // ─── Events ──────────────────────────────────────────

  subscribe(listener: SessionEventListener): () => void {
    this.#subscribers.add(listener);
    return () => { this.#subscribers.delete(listener); };
  }

  // ─── Private ─────────────────────────────────────────

  async #initAgent(): Promise<void> {
    const { createAgent } = await import("@chengchenccc/framework");
    const agent = await createAgent({
      model: this.#config.model,
      threadId: this.#config.threadId,
      tools: this.#config.tools,
      plugins: this.#config.plugins,
      checkpointer: this.#config.checkpointer,
      contextManager: this.#config.contextManager,
      logger: this.#config.logger,
      systemPrompt: this.#config.systemPrompt,
    });
    this.#agent = agent;
    this.#unsubAgent = agent.subscribe((event) => this.#handleAgentEvent(event));
  }

  #handleAgentEvent(event: AgentEvent): void {
    if (event.type === "message") {
      const payload = event.payload;
      if (payload.state === "done" || payload.state === "error") {
        this.#state = payload.state === "done" ? "done" : "error";
      }
    }
    // Pass through all agent events to session subscribers
    // (agent_end is enhanced below in #runLoop)
    this.#emit(event);
  }

  async #runLoop(inputMessages?: Message[], opts?: { signal?: AbortSignal }): Promise<void> {
    this.#state = "running";
    this.#retryCount = 0;
    this.#abortController = new AbortController();
    const signal = this.#combineSignal(opts?.signal);

    try {
      while (true) {
        try {
          if (inputMessages) {
            const generator = this.#agent.run(inputMessages, {
              signal,
              maxSteps: this.#config.maxSteps,
              steering: this.#makeSteeringQueue(),
              followUp: this.#makeFollowUpQueue(),
            });
            for await (const _ of generator) {
              // events handled by agent subscriber
            }
          } else {
            const generator = this.#agent.continue({
              signal,
              maxSteps: this.#config.maxSteps,
              steering: this.#makeSteeringQueue(),
              followUp: this.#makeFollowUpQueue(),
            });
            for await (const _ of generator) {
              // events handled by agent subscriber
            }
          }

          // Check if we need to retry or continue
          if (this.#lastError && this.#retryCount < (this.#config.retry?.maxAttempts ?? 3)) {
            this.#retryCount++;
            this.#state = "retrying";
            const delayMs = (this.#config.retry?.backoffMs ?? 2000) * Math.pow(2, this.#retryCount - 1);
            this.#emit({
              type: "auto_retry_start",
              attempt: this.#retryCount,
              maxAttempts: this.#config.retry?.maxAttempts ?? 3,
              delayMs,
              errorMessage: this.#lastError,
            });
            await new Promise((r) => setTimeout(r, delayMs));
            this.#lastError = null;
            inputMessages = undefined;
            continue;
          }

          this.#emit({
            type: "agent_end",
            messages: this.#agent.thread.messages.slice(),
            willRetry: false,
          });

          if (this.#lastError) {
            this.#state = "error";
            this.#emit({
              type: "auto_retry_end",
              success: false,
              attempt: this.#retryCount,
              finalError: this.#lastError,
            });
          } else {
            this.#state = "done";
            if (this.#retryCount > 0) {
              this.#emit({ type: "auto_retry_end", success: true, attempt: this.#retryCount });
            }
          }
          break;

        } catch (err) {
          this.#handleError(err, "run");
          inputMessages = undefined;
          // continue the retry loop
        }
      }
    } finally {
      this.#abortController = null;
    }
  }

  #handleError(err: unknown, phase: string): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.#lastError = msg;
    if (msg.includes("abort") || msg.includes("AbortError")) {
      this.#state = "done";
    }
  }

  #combineSignal(external?: AbortSignal): AbortSignal | undefined {
    if (!external && !this.#abortController) return undefined;
    if (!external) return this.#abortController?.signal;
    if (!this.#abortController) return external;
    // Combine: abort if either aborts
    const combined = new AbortController();
    external.addEventListener("abort", () => combined.abort(external.reason));
    this.#abortController!.signal.addEventListener("abort", () => combined.abort(this.#abortController!.signal.reason));
    return combined.signal;
  }

  #makeSteeringQueue() {
    const self = this;
    return {
      drain(): Message[] {
        const items = self.#steeringQueue.splice(0);
        return items.map((text) => ({ role: "user" as const, text }));
      },
    };
  }

  #makeFollowUpQueue() {
    const self = this;
    return {
      drain(): Message[] {
        const items = self.#followUpQueue.splice(0);
        return items.map((text) => ({ role: "user" as const, text }));
      },
    };
  }

  #emit(event: AgentSessionEvent): void {
    for (const sub of this.#subscribers) {
      try { sub(event); } catch { /* best-effort */ }
    }
  }
}
```

- [ ] **Step 2: Add basic test**

Create `packages/harness/src/agent-session.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { echoModel } from "@chengchenccc/test-helpers";
import { AgentSession } from "./agent-session.js";

describe("AgentSession", () => {
  test("prompt runs and reaches done state", async () => {
    const model = echoModel([{ text: "hello world" }]);
    const session = new AgentSession({ model });
    const events: string[] = [];
    session.subscribe((e) => events.push(e.type));

    await session.prompt("hi");

    expect(session.state).toBe("done");
    expect(events).toContain("message");
    expect(events).toContain("agent_end");
    session.dispose();
  });

  test("subscribe returns unsubscribe function", async () => {
    const model = echoModel([{ text: "hello" }]);
    const session = new AgentSession({ model });
    const events: string[] = [];
    const unsub = session.subscribe((e) => events.push(e.type));
    unsub();

    await session.prompt("hi");

    expect(events.length).toBe(0);
    session.dispose();
  });

  test("state transitions through running → done", async () => {
    const model = echoModel([{ text: "ok" }]);
    const session = new AgentSession({ model });
    const states: string[] = [];

    session.subscribe((e) => {
      if (e.type === "message") states.push(session.state);
    });

    await session.prompt("test");
    expect(session.state).toBe("done");
    session.dispose();
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd packages/harness && bun test --test-name-pattern="AgentSession"
```

Expected: tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/harness/src/agent-session.ts packages/harness/src/agent-session.test.ts
git commit -m "feat(harness): add AgentSession class with retry/event/subscribe support"
```

---

### Task 4: Harness — compaction logic

**Files:**
- Create: `packages/harness/src/compaction.ts`

- [ ] **Step 1: Write compaction.ts**

```typescript
import type { ChatModel } from "@chengchenccc/core";
import type { Message } from "@chengchenccc/message";
import { collectStream } from "@chengchenccc/core";
import type { Checkpointer } from "@chengchenccc/framework";

export interface CompactionOptions {
  model: ChatModel;
  checkpointer: Checkpointer;
  threadId: string;
  keepRecent?: number;
  customInstructions?: string;
  signal?: AbortSignal;
}

export interface CompactionResult {
  originalCount: number;
  compactedCount: number;
  summaryLength: number;
}

/**
 * Compact a thread by summarizing old messages and keeping recent ones.
 * Returns the compacted messages (does NOT save — caller decides).
 */
export async function compactThread(opts: CompactionOptions): Promise<{
  messages: Message[];
  result: CompactionResult;
}> {
  const keepRecent = opts.keepRecent ?? 10;
  const allMessages = await opts.checkpointer.load(opts.threadId);

  if (allMessages.length <= keepRecent) {
    return {
      messages: allMessages,
      result: { originalCount: allMessages.length, compactedCount: allMessages.length, summaryLength: 0 },
    };
  }

  const toSummarize = allMessages.slice(0, -keepRecent);
  const recent = allMessages.slice(-keepRecent);

  const summaryText = await summarizeMessages(toSummarize, opts.model, opts.customInstructions, opts.signal);
  const summaryMessage: Message = { role: "user", text: summaryText };

  const compacted = [summaryMessage, ...recent];

  return {
    messages: compacted,
    result: {
      originalCount: allMessages.length,
      compactedCount: compacted.length,
      summaryLength: summaryText.length,
    },
  };
}

async function summarizeMessages(
  messages: Message[],
  model: ChatModel,
  customInstructions?: string,
  signal?: AbortSignal,
): Promise<string> {
  const instruction = customInstructions ?? "Summarize the conversation so far, capturing key decisions, progress, and open questions.";
  const prompt: Message = {
    role: "user",
    text: `<task>${instruction}</task>\n\n<conversation>\n${formatMessages(messages)}\n</conversation>\n\nProvide a concise summary.`,
  };

  const stream = model.stream([prompt], { signal });
  const collected = await collectStream(stream);
  const text = collected.blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return text || "(summary unavailable)";
}

function formatMessages(messages: Message[]): string {
  return messages
    .map((m) => {
      const role = m.role;
      const text = m.text ?? m.blocks?.filter((b) => b.type === "text").map((b) => b.text).join(" ") ?? "";
      return `[${role}]: ${text}`;
    })
    .join("\n");
}

// ─── Reflection guidance (moved from reflect.ts) ───────

/** Prompt for fire-and-forget reflection runs. */
export function reflectionGuidance(): string {
  return `You are in a reflection session. Review the conversation above and update your memory.

1. Read the daily log at memory/{today}.md and memory/{yesterday}.md
2. Identify new observations, patterns, or lessons
3. Write observations to today's daily log
4. If your understanding of yourself (SOUL.md) or the user (USER.md) should change, update those files
5. Update MEMORY.md index if new fact files were created

Be concise. Only write if there is something worth recording.`;
}
```

- [ ] **Step 2: Add test**

Create `packages/harness/src/compaction.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { echoModel } from "@chengchenccc/test-helpers";
import { inMemoryCheckpointer } from "@chengchenccc/framework";
import { compactThread, reflectionGuidance } from "./compaction.js";

describe("compactThread", () => {
  test("keeps all messages when under keepRecent threshold", async () => {
    const model = echoModel([{ text: "summary" }]);
    const cp = inMemoryCheckpointer();
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: "user" as const,
      text: `message ${i}`,
    }));
    await cp.save("t1", messages);

    const result = await compactThread({ model, checkpointer: cp, threadId: "t1", keepRecent: 10 });

    expect(result.result.originalCount).toBe(5);
    expect(result.result.compactedCount).toBe(5);
  });

  test("compacts messages when over threshold", async () => {
    const model = echoModel([{ text: "This is a summary of the conversation." }]);
    const cp = inMemoryCheckpointer();
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      text: `message ${i}`,
    }));
    await cp.save("t1", messages);

    const result = await compactThread({ model, checkpointer: cp, threadId: "t1", keepRecent: 10 });

    expect(result.result.originalCount).toBe(20);
    expect(result.result.compactedCount).toBe(11); // 1 summary + 10 recent
    expect(result.messages[0]!.text).toContain("summary");
  });
});

describe("reflectionGuidance", () => {
  test("returns non-empty string", () => {
    expect(reflectionGuidance().length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd packages/harness && bun test --test-name-pattern="compactThread|reflectionGuidance"
```

- [ ] **Step 4: Commit**

```bash
git add packages/harness/src/compaction.ts packages/harness/src/compaction.test.ts
git commit -m "feat(harness): add compaction logic and reflectionGuidance"
```

---

### Task 5: Harness — identityPlugin

**Files:**
- Create: `packages/harness/src/plugins/identity-plugin.ts`
- Copy logic from: `packages/harness/src/bootstrap.ts` and `packages/harness/src/system-prompt.ts`

- [ ] **Step 1: Write identityPlugin**

```typescript
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "@chengchenccc/framework";
import type { Message } from "@chengchenccc/message";
import { composeSystemPrompt } from "../system-prompt.js";
import { todayAndYesterday } from "../daily-log.js";

export interface IdentityPluginOptions {
  cwd: string;
}

// BOOTSTRAP_TEMPLATE from bootstrap.ts — used when no SOUL.md exists
export const BOOTSTRAP_TEMPLATE = `You are a new agent. This is your genesis moment.

Your first task is to understand who you are and what you can do. Read the tools available to you and the system context. Then:

1. Create your SOUL.md — define your personality, principles, and working style
2. Create your USER.md — describe what you know about your user so far
3. Create memory/MEMORY.md — start your memory index
4. Create AGENTS.md — if you need to coordinate with other agents
5. Create TOOLS.md — document any tool usage patterns you discover

Use the write tool to create these files in your workspace directory.`;

/**
 * identityPlugin — reads identity files from cwd and injects system prompt.
 * Handles genesis mode (BOOTSTRAP_TEMPLATE) when no SOUL.md exists.
 */
export function identityPlugin(opts: IdentityPluginOptions): Plugin {
  const { cwd } = opts;

  async function readFile(path: string): Promise<string | null> {
    try {
      const full = join(cwd, path);
      if (!existsSync(full)) return null;
      return readFileSync(full, "utf-8");
    } catch {
      return null;
    }
  }

  return {
    name: "identity",
    hooks: {
      async beforeModel(_ctx, messages: Message[]): Promise<Message[]> {
        const { today, yesterday } = todayAndYesterday();

        // Check genesis mode
        const bootstrap = await readFile("BOOTSTRAP.md");
        const soul = await readFile("SOUL.md");

        if (!soul) {
          // Genesis mode: inject BOOTSTRAP_TEMPLATE
          const template = bootstrap ?? BOOTSTRAP_TEMPLATE;
          return [{ role: "system", text: template }, ...messages];
        }

        // Normal mode: compose full system prompt
        const [userDoc, toolsDoc, agentsDoc, todayLog, yestLog] = await Promise.all([
          readFile("USER.md"),
          readFile("TOOLS.md"),
          readFile("AGENTS.md"),
          readFile(`memory/${today}.md`),
          readFile(`memory/${yesterday}.md`),
        ]);

        const prompt = composeSystemPrompt({
          soul,
          user: userDoc ?? "",
          tools: toolsDoc ?? "",
          agents: agentsDoc ?? "",
          todayLog: todayLog ?? "",
          yestLog: yestLog ?? "",
          today,
          yesterday,
        });

        return [{ role: "system", text: prompt }, ...messages];
      },
    },
  };
}
```

- [ ] **Step 2: Add test**

Create `packages/harness/src/plugins/identity-plugin.test.ts`:

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { identityPlugin, BOOTSTRAP_TEMPLATE } from "./identity-plugin.js";

describe("identityPlugin", () => {
  let cwd: string;

  beforeAll(() => {
    cwd = join(tmpdir(), `identity-test-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
  });

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("returns BOOTSTRAP_TEMPLATE in genesis mode (no SOUL.md)", async () => {
    const plugin = identityPlugin({ cwd });
    const hooks = plugin.hooks;
    const result = await hooks!.beforeModel!({ threadId: "t1" } as any, [
      { role: "user", text: "hello" },
    ]);

    expect(result[0]!.text).toContain("genesis moment");
  });

  test("composes system prompt when SOUL.md exists", async () => {
    writeFileSync(join(cwd, "SOUL.md"), "I am a test agent");
    writeFileSync(join(cwd, "USER.md"), "Test user");

    const plugin = identityPlugin({ cwd });
    const result = await plugin.hooks!.beforeModel!({ threadId: "t1" } as any, [
      { role: "user", text: "hello" },
    ]);

    expect(result[0]!.text).toContain("I am a test agent");
    expect(result[0]!.text).toContain("Test user");
  });
});
```

- [ ] **Step 3: Run test**

```bash
cd packages/harness && bun test --test-name-pattern="identityPlugin"
```

- [ ] **Step 4: Commit**

```bash
git add packages/harness/src/plugins/identity-plugin.ts packages/harness/src/plugins/identity-plugin.test.ts
git commit -m "feat(harness): add identityPlugin (extracted from bootstrap)"
```

---

### Task 6: Harness — index.ts update

**Files:**
- Modify: `packages/harness/src/index.ts`

- [ ] **Step 1: Add new exports while keeping old**

In `packages/harness/src/index.ts`, add before existing exports:

```typescript
// New (Phase 1)
export { AgentSession } from "./agent-session.js";
export type {
  AgentSessionConfig,
  AgentSessionEvent,
  AgentState,
  CompactionResult,
  CompactionSettings,
  ContextUsage,
  RetrySettings,
  SessionEventListener,
  ThinkingLevel,
  ToolInfo,
} from "./agent-session.js";
export { compactThread, reflectionGuidance } from "./compaction.js";
export type { CompactionOptions } from "./compaction.js";
export { identityPlugin, BOOTSTRAP_TEMPLATE } from "./plugins/identity-plugin.js";
export type { IdentityPluginOptions } from "./plugins/identity-plugin.js";
```

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/harness && bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add packages/harness/src/index.ts
git commit -m "feat(harness): export AgentSession, compaction, identityPlugin from barrel"
```

---

### Task 7: Tools-common — cwd-based tool factories

**Files:**
- Create: `packages/tools-common/src/file-tools.ts`

- [ ] **Step 1: Write file-tools.ts with cwd-based factories**

```typescript
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { Tool } from "@chengchenccc/core";

/** Simple cwd-based default — tools resolve relative paths against this. */
export function withDefaultCwd(tool: Tool, cwd: string): Tool {
  return {
    ...tool,
    execute: async (input, signal) => {
      return tool.execute({ ...input, cwd: input.cwd ?? cwd }, signal);
    },
  };
}

/** Create a read-file tool scoped to a cwd. */
export function createReadTool(opts: { cwd: string }): Tool {
  const { cwd } = opts;
  return {
    name: "read",
    description: "Read a file from the workspace. Returns the file contents as text.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read, relative to workspace root" },
      },
      required: ["path"],
    },
    async execute(input) {
      const full = resolve(cwd, input.path);
      if (!full.startsWith(cwd)) return { content: `Error: path escapes workspace`, isError: true };
      try {
        const content = readFileSync(full, "utf-8");
        return { content };
      } catch (err) {
        return { content: `Error reading file: ${err instanceof Error ? err.message : err}`, isError: true };
      }
    },
  };
}

/** Create a write-file tool scoped to a cwd. */
export function createWriteTool(opts: { cwd: string }): Tool {
  const { cwd } = opts;
  return {
    name: "write",
    description: "Write content to a file in the workspace. Creates parent directories as needed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write, relative to workspace root" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    },
    async execute(input) {
      const full = resolve(cwd, input.path);
      if (!full.startsWith(cwd)) return { content: `Error: path escapes workspace`, isError: true };
      try {
        const dir = dirname(full);
        const { mkdirSync } = await import("node:fs");
        mkdirSync(dir, { recursive: true });
        writeFileSync(full, input.content, "utf-8");
        return { content: `Written to ${input.path}` };
      } catch (err) {
        return { content: `Error writing file: ${err instanceof Error ? err.message : err}`, isError: true };
      }
    },
  };
}

/** Create an edit-file tool scoped to a cwd. */
export function createEditTool(opts: { cwd: string }): Tool {
  const { cwd } = opts;
  return {
    name: "edit",
    description: "Perform exact string replacements in a file in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit, relative to workspace root" },
        old_string: { type: "string", description: "The exact text to replace" },
        new_string: { type: "string", description: "The text to replace it with" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute(input) {
      const full = resolve(cwd, input.path);
      if (!full.startsWith(cwd)) return { content: `Error: path escapes workspace`, isError: true };
      try {
        const content = readFileSync(full, "utf-8");
        if (!content.includes(input.old_string)) {
          return { content: `Error: old_string not found in file. The file may have changed since you last read it.`, isError: true };
        }
        const newContent = content.replace(input.old_string, input.new_string);
        writeFileSync(full, newContent, "utf-8");
        return { content: `Edited ${input.path}` };
      } catch (err) {
        return { content: `Error editing file: ${err instanceof Error ? err.message : err}`, isError: true };
      }
    },
  };
}
```

- [ ] **Step 2: Add test**

Create `packages/tools-common/src/file-tools.test.ts`:

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReadTool, createWriteTool, createEditTool } from "./file-tools.js";

describe("cwd-based file tools", () => {
  let cwd: string;

  beforeAll(() => {
    cwd = join(tmpdir(), `file-tools-test-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
  });

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("read tool reads file contents", async () => {
    writeFileSync(join(cwd, "test.txt"), "hello world");
    const tool = createReadTool({ cwd });
    const result = await tool.execute({ path: "test.txt" });
    expect(result.content).toBe("hello world");
  });

  test("read tool blocks path escape", async () => {
    const tool = createReadTool({ cwd });
    const result = await tool.execute({ path: "../../../etc/passwd" });
    expect(result.isError).toBe(true);
  });

  test("write tool creates file", async () => {
    const tool = createWriteTool({ cwd });
    const result = await tool.execute({ path: "out.txt", content: "generated content" });
    expect(result.content).toContain("Written");
    expect(readFileSync(join(cwd, "out.txt"), "utf-8")).toBe("generated content");
  });

  test("edit tool replaces string", async () => {
    writeFileSync(join(cwd, "edit.txt"), "foo bar baz");
    const tool = createEditTool({ cwd });
    const result = await tool.execute({ path: "edit.txt", old_string: "bar", new_string: "qux" });
    expect(result.content).toContain("Edited");
    expect(readFileSync(join(cwd, "edit.txt"), "utf-8")).toBe("foo qux baz");
  });

  test("edit tool errors when old_string not found", async () => {
    writeFileSync(join(cwd, "edit.txt"), "hello");
    const tool = createEditTool({ cwd });
    const result = await tool.execute({ path: "edit.txt", old_string: "nonexistent", new_string: "x" });
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd packages/tools-common && bun test --test-name-pattern="cwd-based file tools"
```

- [ ] **Step 4: Commit**

```bash
git add packages/tools-common/src/file-tools.ts packages/tools-common/src/file-tools.test.ts
git commit -m "feat(tools-common): add cwd-based file tool factories (read/write/edit)"
```

---

### Task 8: Tools-common — index.ts update

**Files:**
- Modify: `packages/tools-common/src/index.ts`

- [ ] **Step 1: Add new exports**

```typescript
// New cwd-based tools (Phase 1)
export { createReadTool, createWriteTool, createEditTool, withDefaultCwd } from "./file-tools.js";
```

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/tools-common && bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add packages/tools-common/src/index.ts
git commit -m "feat(tools-common): export cwd-based tool factories"
```

---

### Task 9: Plugin-FS-Memory — migrate AgentFsLike → cwd

**Files:**
- Modify: `packages/plugin-fs-memory/src/fs-memory.ts`
- Modify: `packages/plugin-fs-memory/src/memory-read.ts`
- Modify: `packages/plugin-fs-memory/src/memory-write.ts`
- Modify: `packages/plugin-fs-memory/src/memory-search.ts`
- Modify: `packages/plugin-fs-memory/src/cache.ts`
- Modify: `packages/plugin-fs-memory/src/frontmatter.ts`
- Modify: `packages/plugin-fs-memory/src/index.ts`

- [ ] **Step 1: Update FsMemoryOptions to accept cwd**

In `packages/plugin-fs-memory/src/fs-memory.ts`, change the options type:

```typescript
export interface FsMemoryOptions {
  cwd: string;             // NEW: workspace root directory
  // DEPRECATED: kept for backward compat
  ws?: import("@chengchenccc/tools-common").AgentFsLike;
  root?: string;
  enableWrite?: boolean;
  searchLimit?: number;
}
```

Update `fsMemoryPlugin` to use `cwd` to build a simple `AgentFsLike` adapter internally:

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

function nodeFsAdapter(cwd: string): import("@chengchenccc/tools-common").AgentFsLike {
  return {
    async read(path: string) {
      try {
        const full = resolve(cwd, path);
        if (!full.startsWith(cwd)) return null;
        return readFileSync(full, "utf-8");
      } catch { return null; }
    },
    async write(path: string, content: string) {
      const full = resolve(cwd, path);
      if (!full.startsWith(cwd)) throw new Error("Path escapes workspace");
      mkdirSync(resolve(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf-8");
    },
    async list(path: string) {
      try {
        const full = resolve(cwd, path);
        if (!full.startsWith(cwd)) return [];
        return readdirSync(full);
      } catch { return []; }
    },
    async stat(path: string) {
      try {
        const full = resolve(cwd, path);
        if (!full.startsWith(cwd)) return null;
        const s = statSync(full);
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch { return null; }
    },
    async exists(path: string) {
      const full = resolve(cwd, path);
      return full.startsWith(cwd) && existsSync(full);
    },
    async mkdirp(path: string) {
      const full = resolve(cwd, path);
      if (!full.startsWith(cwd)) throw new Error("Path escapes workspace");
      mkdirSync(full, { recursive: true });
    },
  };
}
```

The plugin function resolves `cwd` to create the adapter if no `ws` provided:

```typescript
export function fsMemoryPlugin(options: FsMemoryOptions): Plugin {
  const ws = options.ws ?? nodeFsAdapter(options.cwd);
  const root = options.root ?? "memory";
  // ... rest of implementation unchanged
}
```

- [ ] **Step 2: Run existing tests to verify backward compat**

```bash
cd packages/plugin-fs-memory && bun test
```

- [ ] **Step 3: Commit**

```bash
git add packages/plugin-fs-memory/src/
git commit -m "feat(plugin-fs-memory): support cwd option alongside AgentFsLike"
```

---

### Task 10: Plugin-Progressive-Skill — migrate AgentFsLike → cwd

**Files:**
- Modify: `packages/plugin-progressive-skill/src/progressive-skill.ts`
- Modify: `packages/plugin-progressive-skill/src/skill-load.ts`
- Modify: `packages/plugin-progressive-skill/src/cache.ts`

- [ ] **Step 1: Update ProgressiveSkillOptions**

In `packages/plugin-progressive-skill/src/progressive-skill.ts`, change:

```typescript
export interface ProgressiveSkillOptions {
  cwd: string;           // NEW: workspace root directory
  root?: string;
  roots?: string[];
  maxCharsPerLoad?: number;
  posixSkillRoot?: string;
  // DEPRECATED
  ws?: import("@chengchenccc/tools-common").AgentFsLike;
}
```

Same pattern as Task 9 — build `nodeFsAdapter(cwd)` if `ws` not provided, falling through to existing logic.

- [ ] **Step 2: Run existing tests**

```bash
cd packages/plugin-progressive-skill && bun test
```

- [ ] **Step 3: Commit**

```bash
git add packages/plugin-progressive-skill/src/
git commit -m "feat(plugin-progressive-skill): support cwd option alongside AgentFsLike"
```

---

### Task 11: Framework — checkpointer.deleteThread()

**Files:**
- Modify: `packages/framework/src/checkpointer.ts`
- Modify: `packages/framework/src/checkpointers/sqlite-checkpointer.ts`
- Modify: `packages/framework/src/checkpointers/in-memory.ts`
- Modify: `packages/framework/src/checkpointers/file-checkpointer.ts`

- [ ] **Step 1: Add deleteThread to Checkpointer interface**

In `packages/framework/src/checkpointer.ts`, add to the `Checkpointer` interface:

```typescript
  /** Delete all data for a thread. Idempotent — no-op if thread doesn't exist. */
  deleteThread?(threadId: string): Promise<void>;
```

- [ ] **Step 2: Implement deleteThread in sqlite-checkpointer.ts**

```typescript
async deleteThread(threadId: string): Promise<void> {
  await db.delete(checkpointMessages).where(eq(checkpointMessages.threadId, threadId));
  await db.delete(checkpointInterrupts).where(eq(checkpointInterrupts.threadId, threadId));
  await db.delete(checkpointEvents).where(eq(checkpointEvents.threadId, threadId));
}
```

- [ ] **Step 3: Implement deleteThread in in-memory.ts**

```typescript
async deleteThread(threadId: string): Promise<void> {
  this.#store.delete(threadId);
  this.#interrupts.delete(threadId);
  this.#events.delete(threadId);
}
```

- [ ] **Step 4: Implement deleteThread in file-checkpointer.ts**

Delete `{threadId}.state.json`, `{threadId}.interrupt.json`, `{threadId}.events.jsonl` from the checkpointer directory.

- [ ] **Step 5: Run tests and commit**

```bash
cd packages/framework && bun test
git add packages/framework/src/checkpointer.ts packages/framework/src/checkpointers/
git commit -m "feat(framework): add deleteThread() to Checkpointer interface"
```

---

### Phase 1 Gate Check

- [ ] Run full repo typecheck and lint:

```bash
bun run typecheck && bun run lint
```

Expected: no errors. All existing code compiles with new APIs present alongside old.

---

## Phase 2: Backend + Frontend switch

### Task 12: Message package — runStatus on MessageRevision

**Files:**
- Modify: `packages/message/src/revision.ts`
- Modify: `packages/message/src/parser.ts` (if schema-based)
- Modify: `packages/message/src/helpers.ts` (if needed)

- [ ] **Step 1: Add runStatus field to MessageRevision**

In `packages/message/src/revision.ts`:

```typescript
export interface MessageRevision {
  messageId: string;
  state: MessageState;
  role: MessageRole;
  text?: string;
  blocks?: ContentBlock[];
  tools?: MessageToolState[];
  runId?: string;
  conversationId?: string;
  visibility?: "internal" | "conversation";
  updatedAt: number;
  error?: MessageError;
  /** Transient run status indicator (retrying/compacting). Not persisted to ledger. */
  runStatus?: "running" | "retrying" | "compacting" | "waiting";
}
```

- [ ] **Step 2: Update MessageRevisionSchema in parser.ts**

In `packages/message/src/parser.ts`, add `runStatus` as an optional field in the zod schema:

```typescript
// Inside MessageRevisionSchema:
  runStatus: z.enum(["running", "retrying", "compacting", "waiting"]).optional(),
```

- [ ] **Step 3: Run existing tests**

```bash
cd packages/message && bun test
```

Expected: all existing tests pass (new optional field is backward compatible).

- [ ] **Step 4: Commit**

```bash
git add packages/message/src/revision.ts packages/message/src/parser.ts
git commit -m "feat(message): add runStatus field to MessageRevision"
```

---

### Task 13: Backend — Conversation tools

**Files:**
- Create: `apps/backend/src/features/conversation/conv-tools.ts`

- [ ] **Step 1: Write conversation tools**

```typescript
import type { Tool } from "@chengchenccc/core";
import type { ConversationPort } from "./ports.js";

interface ConvToolDeps {
  convPort: ConversationPort;
  conversationId: string;
}

/** Read recent conversation history from the ledger. */
export function createReadHistoryTool(deps: ConvToolDeps): Tool {
  return {
    name: "read_conversation_history",
    description: "Read recent messages from the current conversation. Returns the last N messages in chronological order.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of recent messages to return (default: 20)" },
      },
    },
    async execute(input) {
      const limit = input.limit ?? 20;
      try {
        const entries = await deps.convPort.getLedgerEntries(deps.conversationId, { limit, kind: "message" });
        const formatted = entries.map((e) => {
          const parsed = JSON.parse(e.content);
          const text = parsed.text ?? "";
          return `[${e.senderMemberId} seq=${e.seq}]: ${text}`;
        }).join("\n");
        return { content: formatted || "(no messages yet)" };
      } catch (err) {
        return { content: `Error reading history: ${err instanceof Error ? err.message : err}`, isError: true };
      }
    },
  };
}

/** Read context around a specific message. */
export function createReadContextTool(deps: ConvToolDeps): Tool {
  return {
    name: "read_message_context",
    description: "Read messages before and after a specific message for context.",
    inputSchema: {
      type: "object",
      properties: {
        around_seq: { type: "number", description: "The seq number of the message to center on" },
        before: { type: "number", description: "Number of messages before (default: 5)" },
        after: { type: "number", description: "Number of messages after (default: 5)" },
      },
      required: ["around_seq"],
    },
    async execute(input) {
      try {
        const entries = await deps.convPort.getLedgerContext(deps.conversationId, input.around_seq, {
          before: input.before ?? 5,
          after: input.after ?? 5,
        });
        const formatted = entries.map((e) => {
          const parsed = JSON.parse(e.content);
          return `[seq=${e.seq} ${e.senderMemberId}]: ${parsed.text ?? "(non-text)"}`;
        }).join("\n");
        return { content: formatted || "(no context found)" };
      } catch (err) {
        return { content: `Error reading context: ${err instanceof Error ? err.message : err}`, isError: true };
      }
    },
  };
}

/** Search conversation messages by keyword. */
export function createSearchTool(deps: ConvToolDeps): Tool {
  return {
    name: "search_conversation",
    description: "Search the conversation history for messages containing a keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword or phrase to search for" },
        limit: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["query"],
    },
    async execute(input) {
      try {
        const entries = await deps.convPort.searchLedger(deps.conversationId, input.query, input.limit ?? 10);
        const formatted = entries.map((e) => {
          const parsed = JSON.parse(e.content);
          return `[seq=${e.seq} ${e.senderMemberId}]: ${parsed.text ?? "(non-text)"}`;
        }).join("\n");
        return { content: formatted || "(no results)" };
      } catch (err) {
        return { content: `Error searching: ${err instanceof Error ? err.message : err}`, isError: true };
      }
    },
  };
}

/** List conversation members. */
export function createListMembersTool(deps: ConvToolDeps): Tool {
  return {
    name: "list_members",
    description: "List all members in this conversation.",
    inputSchema: { type: "object", properties: {} },
    async execute(_input) {
      try {
        const conv = await deps.convPort.getConversation(deps.conversationId);
        const members = conv.members.map((m) => `- ${m.displayName ?? m.memberId} (${m.kind})`).join("\n");
        return { content: members || "(no members)" };
      } catch (err) {
        return { content: `Error listing members: ${err instanceof Error ? err.message : err}`, isError: true };
      }
    },
  };
}
```

- [ ] **Step 2: Verify compilation (tests will come with integration)**

```bash
cd apps/backend && bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/conversation/conv-tools.ts
git commit -m "feat(backend): add conversation tools (read_history/read_context/search/members)"
```

---

### Task 14: Backend — ConversationContextPlugin integration

**Files:**
- Modify: `apps/backend/src/features/conversation/conv-svc-factory.ts`
- Create: `packages/harness/src/plugins/conversation-context-plugin.ts`

- [ ] **Step 1: Create ConversationContextPlugin in harness**

```typescript
// packages/harness/src/plugins/conversation-context-plugin.ts
import type { Plugin } from "@chengchenccc/framework";
import type { Tool } from "@chengchenccc/core";
import type { Message } from "@chengchenccc/message";

export interface ConversationContextPluginOptions {
  tools: Tool[];
  systemPrompt: string;
}

/**
 * ConversationContextPlugin — injects conversation context into agent runs.
 * Backend creates tools (with convPort closures) and system prompt, plugin just assembles.
 */
export function ConversationContextPlugin(opts: ConversationContextPluginOptions): Plugin {
  return {
    name: "conversation-context",
    tools: opts.tools,
    hooks: {
      async beforeModel(_ctx, messages: Message[]): Promise<Message[]> {
        // Inject conversation context as system message before the model call
        const contextMsg: Message = { role: "system", text: opts.systemPrompt };
        return [contextMsg, ...messages];
      },
    },
  };
}
```

- [ ] **Step 2: Rewrite forkRun → startAgentRun in conv-svc-factory.ts**

Replace the `forkRun` closure in `createConversationFeature`:

```typescript
// Old: forkRun calls buildAgentSpecV2 + buildPreloadedMessages + dispatcher.dispatch
// New: startAgentRun creates AgentSession directly

async function startAgentRun(
  threadId: string,
  agentId: string,
  input: string,
  ctx: {
    conversationId: string;
    convPort: ConversationPort;
    surface?: string;
    senderName?: string;
  },
) {
  const agent = await agentSvc.getById(agentId);
  const cwd = join(config.dataDir, "agents", agentId);
  const { conversationId, convPort, surface, senderName } = ctx;

  // Build conversation tools
  const convTools = [
    createReadHistoryTool({ convPort, conversationId }),
    createReadContextTool({ convPort, conversationId }),
    createSearchTool({ convPort, conversationId }),
    createListMembersTool({ convPort, conversationId }),
  ];

  // Build conversation system prompt
  const convPrompt = `<conversation>
  <id>${conversationId}</id>
  <surface>${surface ?? "web"}</surface>
  <trigger>
    <from>${senderName ?? "unknown"}</from>
    <message>${input}</message>
  </trigger>
</conversation>
如果需要更多上下文，使用 read_conversation_history 等工具。`;

  // Assemble plugins
  const plugins: Plugin[] = [
    identityPlugin({ cwd }),
    ConversationContextPlugin({ tools: convTools, systemPrompt: convPrompt }),
    fsMemoryPlugin({ cwd }),
    progressiveSkillPlugin({ cwd }),
  ];

  const checkpointer = sqliteCheckpointer({ db: join(config.dataDir, "checkpointer.db") });
  const contextManager = pipeContextManagers(
    toolResultTruncator({ maxCharsPerResult: 50_000 }),
    autoSummarize({ triggerAt: 100_000, keepRecent: 10 }),
  );

  const session = new AgentSession({
    model: createModel(agent.model),
    threadId,
    plugins,
    checkpointer,
    contextManager,
    logger: consoleLogger({ level: "info" }),
  });

  // Wire events to ledger
  session.subscribe((event) => {
    if (event.type === "message") {
      // Write assistant message to ledger → SSE broadcast
      const revision = event.payload;
      if (revision.role === "assistant") {
        convPort.appendLedgerEntry({
          conversationId,
          senderMemberId: agentMemberId(agentId),
          kind: "message",
          content: serializeLedgerEntry({
            seq: 0, // assigned by DB
            conversationId,
            senderMemberId: agentMemberId(agentId),
            addressedTo: [],
            kind: "message",
            content: serializeMessageRevision(revision),
            ts: Date.now(),
            runId: threadId,
          }),
        }).catch(console.error);
      }
    }
    // Ops events (retry/compaction) logged separately
  });

  await session.prompt(input);
  session.dispose();
}
```

- [ ] **Step 3: Run existing backend tests to catch breakage**

```bash
cd apps/backend && bun test
```

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/features/conversation/conv-svc-factory.ts packages/harness/src/plugins/conversation-context-plugin.ts packages/harness/src/index.ts
git commit -m "feat(backend): integrate AgentSession with ConversationContextPlugin, replace forkRun"
```

---

### Task 15: Backend — Supervisor degradation to RunLifecycleTracker

**Files:**
- Modify: `apps/backend/src/features/run/supervisor.ts`

- [ ] **Step 1: Remove transport routing, keep run/attempt lifecycle**

Remove from `RunSupervisor`:
- `bindTransport()`, `#handleRunnerMessage()`, transport field on `RunSession`
- `startMainRun()` no longer calls `transport.send("start")`
- `cancel()` no longer calls `transport.send("abort")`
- `rediscover()` no longer calls `registry.attachExisting()`
- Heartbeat reaper becomes simpler (no transport to check)

Keep:
- `RunSession` (runId, attemptId, threadId, agentId, kind, abortController)
- run/attempt row management (INSERT/UPDATE with CAS)
- `#finalizeRun()` with CAS semantics
- `onRunComplete()` / `onRunMessage()` / `onRunEvent()` callback registrations
- `cancelAll()` (just aborts controllers)
- Reaper: checks `attempt.ended_at IS NULL` and `now - started_at > stepStallTimeout` → CAS finalize to "interrupted"

- [ ] **Step 2: Run supervisor tests**

```bash
cd apps/backend && bun test --test-name-pattern="supervisor"
```

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/features/run/supervisor.ts
git commit -m "refactor(backend): degrade RunSupervisor to RunLifecycleTracker (remove transport)"
```

---

### Task 16: Backend — Dispatcher removal

**Files:**
- Remove: `apps/backend/src/features/run/dispatcher.ts` (absorb into startAgentRun)
- Modify: `apps/backend/src/features/run/service.ts`

- [ ] **Step 1: Inline dispatcher logic into run service**

`dispatcher.dispatch()` did two things:
1. `opsStore.insertRunOrigin()` — keep this call
2. `supervisor.startMainRun()` — replace with AgentSession creation

Update `RunService.start()` to create AgentSession directly instead of calling `dispatcher.dispatch()`.

- [ ] **Step 2: Commit**

```bash
git add apps/backend/src/features/run/service.ts
git commit -m "refactor(backend): inline dispatcher logic, remove dispatcher dependency"
```

---

### Task 17: Backend — main.ts AgentSession integration

**Files:**
- Modify: `apps/backend/src/main.ts`

- [ ] **Step 1: Rewrite main.ts assembly**

Remove:
- `RunnerRegistry` creation (`createRunnerRegistry`)
- `RunDispatcher` creation (`createRunDispatcher`)
- Transport wiring (`supervisor.bindTransport`)
- `supervisor.rediscover()`
- Daemon lifecycle management
- `threadProjectionRoutes`

Add:
- Global checkpointer (`sqliteCheckpointer({ db: join(dataDir, "checkpointer.db") })`)
- Direct AgentSession management

- [ ] **Step 2: Commit**

```bash
git add apps/backend/src/main.ts
git commit -m "refactor(backend): integrate AgentSession directly, remove RunnerRegistry/Dispatcher/transport"
```

---

### Task 18: Backend — Agent workspace simplification

**Files:**
- Modify: `apps/backend/src/features/agent/agent-svc-factory.ts`
- Modify: `apps/backend/src/features/agent/identity-store.ts`

- [ ] **Step 1: Simplify workspace to agents/{id} layout**

In `agent-svc-factory.ts`:
- Replace `materializeRunnerWorkspace` with simple `mkdir agents/{id}`
- Replace `purgeRunnerWorkspace` with simple `rm -rf agents/{id}`

In `identity-store.ts`:
- Change paths from `runners/{id}/shared/SOUL.md` to `agents/{id}/SOUL.md`

- [ ] **Step 2: Commit**

```bash
git add apps/backend/src/features/agent/
git commit -m "refactor(backend): simplify workspace to agents/{id} layout"
```

---

### Task 19: Backend — ThreadProjection deletion

**Files:**
- Delete: `apps/backend/src/features/thread-projection/` (6 files)
- Modify: `apps/backend/src/features/conversation/service.ts` (remove threadProjectionWrite calls)
- Modify: `apps/backend/src/http/router.ts` (remove threadProjection routes)

- [ ] **Step 1: Remove broadcastMessage's threadProjectionWrite call**

In `service.ts`, remove `threadProjectionWrite.appendMessages()` from `broadcastMessage`.

- [ ] **Step 2: Remove threadProjectionRoutes from router**

- [ ] **Step 3: Delete the thread-projection directory**

```bash
rm -rf apps/backend/src/features/thread-projection/
```

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/features/conversation/service.ts apps/backend/src/http/router.ts
git rm -r apps/backend/src/features/thread-projection/
git commit -m "refactor(backend): delete ThreadProjection (dead code)"
```

---

### Task 20: Backend — Runtime-ops cleanup

**Files:**
- Modify: `apps/backend/src/features/runtime-ops/types.ts`
- Modify: `apps/backend/src/features/runtime-ops/store.ts`
- Modify: `apps/backend/src/features/runtime-ops/service.ts`

- [ ] **Step 1: Remove RunnerHealth types and queries**

Remove from types.ts: `RunnerHealthRow`, `RunnerHealthStatus`, `computeRunnerStatus`
Remove from store.ts: `upsertRunnerHealth`, `getRunnerHealth`
Remove from service.ts: runner health queries, runner transport status from `listRuns`

- [ ] **Step 2: Commit**

```bash
git add apps/backend/src/features/runtime-ops/
git commit -m "refactor(backend): remove runner health from runtime-ops"
```

---

### Task 21: Frontend — runStatus handling in reducer

**Files:**
- Modify: `apps/web/src/lib/conversation-reducer.ts`

- [ ] **Step 1: Extract runStatus from message revisions**

The `message` action already receives `MessageRevision`. No new action needed — `runStatus` is automatically available. Update `isBusy` to consider `runStatus`:

```typescript
export function isBusy(s: ConvState): boolean {
  if (s.pendingSendCount > 0) return true;
  return s.items.some(
    (item) =>
      item.kind === "message" &&
      item.sender.kind === "agent" &&
      (item.content.state != null && isOpenMessageState(item.content.state)) ||
      (item.content.runStatus === "retrying" || item.content.runStatus === "compacting"),
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/lib/conversation-reducer.ts
git commit -m "feat(web): handle runStatus in conversation reducer"
```

---

### Task 22: Frontend — MessageBubble runStatus indicators

**Files:**
- Modify: `apps/web/src/components/MessageBubble.tsx`
- Modify: `apps/web/src/components/ConversationCanvas.tsx`

- [ ] **Step 1: Add runStatus indicators to MessageBubble**

In `MessageBubble.tsx`, read `content.runStatus` and show indicator text:

```tsx
{content.runStatus === "retrying" && (
  <span className="text-amber-500 text-xs animate-pulse">Retrying...</span>
)}
{content.runStatus === "compacting" && (
  <span className="text-blue-500 text-xs animate-pulse">Compacting context...</span>
)}
```

- [ ] **Step 2: Update ConversationCanvas status labels**

Add runStatus to the status label derivation:

```tsx
if (message.content.runStatus === "retrying") return "Retrying...";
if (message.content.runStatus === "compacting") return "Compacting...";
if (message.content.state === "waiting") return "Awaiting Approval";
if (busy) return "Running";
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/MessageBubble.tsx apps/web/src/components/ConversationCanvas.tsx
git commit -m "feat(web): show runStatus indicators (retrying/compacting)"
```

---

### Task 23: Frontend — Ops dashboard cleanup

**Files:**
- Modify: 12 files in `apps/web/src/components/ops/`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/ops-diagnosis.ts`

- [ ] **Step 1: Remove runner concepts from api.ts types**

Remove from `RunOpsListItem`: `runnerTransport`
Remove from `AgentRuntimeStatus`: `runner` block
Remove from query params: `transport`, `heartbeat` filters

- [ ] **Step 2: Remove runner diagnosis from ops-diagnosis.ts**

Remove: `isDetachedRun()`, `isStaleRun()`, `isUnhealthyAgent()` runner section

- [ ] **Step 3: Remove runner UI from ops components**

| File | Change |
|------|--------|
| `RunOpsTable.tsx` | Remove Transport column, Heartbeat column |
| `RunDiagnosisHeader.tsx` | Remove "Runner"/"Runner connection" labels |
| `RunControlStrip.tsx` | Remove Cancel/Recover buttons, "daemon reattached" |
| `ExecutionPath.tsx` | Remove "Runner heartbeat" stage |
| `AgentRuntimeCard.tsx` | Remove runner block (keep surface status) |
| `HealthSummary.tsx` | Remove stale/detached counts |
| `NeedsAttentionList.tsx` | Remove detached/stale alerts |

- [ ] **Step 4: Delete run-status.ts**

```bash
rm apps/web/src/lib/run-status.ts
```

- [ ] **Step 5: Run frontend typecheck**

```bash
cd apps/web && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/
git commit -m "refactor(web): remove runner transport/heartbeat/daemon from ops dashboard"
```

---

### Task 23a: Backend — Orchestrator/Cron AgentSession dispatch

**Files:**
- Modify: `apps/backend/src/features/orchestrator/reactor.ts`
- Modify: `apps/backend/src/features/cron/scheduler.ts`

- [ ] **Step 1: Rewrite orchestrator.startStep to use AgentSession**

Replace `dispatcher.dispatch()` call with direct AgentSession creation. The orchestrator creates its own AgentSession with identityPlugin only (no ConversationContextPlugin — orchestrator runs write to conversation ledger but don't need conversation tools). Wire `session.subscribe()` to emit issue events.

- [ ] **Step 2: Rewrite cron scheduler.fire to use AgentSession**

Replace `dispatcher.dispatch()` with direct AgentSession creation. Cron runs use identityPlugin + any cron-specific plugins. Wire `session.subscribe()` where needed for cron result tracking.

- [ ] **Step 3: Remove dispatcher import from both files**

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/features/orchestrator/reactor.ts apps/backend/src/features/cron/scheduler.ts
git commit -m "refactor(backend): orchestrator and cron use AgentSession directly"
```

---

### Task 23b: packages/conversation — slim down

**Files:**
- Modify: `packages/conversation/src/projection.ts`
- Modify: `packages/conversation/src/index.ts`

- [ ] **Step 1: Move projectForMember to backend**

Copy `projectForMember` function to `apps/backend/src/features/conversation/projection.ts` (it's already used there for `broadcastMessage`). The `packages/conversation` version becomes a re-export from backend or is deprecated.

Keep the function in `packages/conversation` for now but mark `@deprecated — use backend/projection.ts`. Phase 3 will remove it.

- [ ] **Step 2: Remove message re-exports from packages/conversation**

In `packages/conversation/src/index.ts`, remove all re-exports from `@chengchenccc/message`. Callers that need `Message`, `MessageRevision`, etc. should import directly from `@chengchenccc/message`.

Check all imports across the repo and fix:
```bash
grep -r "from ['\"]@chengchenccc/conversation['\"]" --include="*.ts" | grep -v node_modules
```

Update each to import from `@chengchenccc/message` directly for message types.

- [ ] **Step 3: Commit**

```bash
git add packages/conversation/src/ apps/backend/src/features/conversation/projection.ts
git commit -m "refactor(conversation): slim package — remove message re-exports, move projectForMember"
```

---

### Phase 2 Gate Check

- [ ] Run full repo typecheck, lint, and tests:

```bash
bun run typecheck && bun run lint && bun run test
```

---

## Phase 3: Delete old code

### Task 24: Delete runner-protocol package

```bash
rm -rf packages/runner-protocol/
# Update root package.json workspaces if needed
git rm -r packages/runner-protocol/
git commit -m "refactor: delete runner-protocol package"
```

### Task 25: Delete runner-daemon package

```bash
rm -rf packages/runner-daemon/
git rm -r packages/runner-daemon/
git commit -m "refactor: delete runner-daemon package"
```

### Task 26: Delete agent-fs package

```bash
rm -rf packages/agent-fs/
git rm -r packages/agent-fs/
git commit -m "refactor: delete agent-fs package"
```

### Task 27: Delete old harness files

```bash
rm packages/harness/src/create-generic-agent.ts
rm packages/harness/src/bootstrap.ts
rm packages/harness/src/reflect.ts
# Update index.ts to remove old exports
git add packages/harness/src/
git commit -m "refactor(harness): delete createGenericAgent, old bootstrap, reflect"
```

### Task 28: Delete old tools-common files

```bash
rm packages/tools-common/src/sandbox.ts
rm packages/tools-common/src/agent-fs-like.ts
rm packages/tools-common/src/afs-tools.ts
# Update index.ts to remove old exports
git add packages/tools-common/src/
git commit -m "refactor(tools-common): delete sandbox, agent-fs-like, afs-tools"
```

### Task 29: Delete core/agent-fs.ts

```bash
rm packages/core/src/agent-fs.ts
# Update index.ts to remove AgentFsLike, pjoin exports
git add packages/core/src/
git commit -m "refactor(core): delete AgentFsLike interface"
```

### Task 30: Delete backend runner files

```bash
rm apps/backend/src/features/run/runner-registry.ts
rm apps/backend/src/features/run/runner-registry-factory.ts
rm apps/backend/src/features/run/dispatcher.ts
rm apps/backend/src/infra/runner-workspace.ts
git add apps/backend/src/
git commit -m "refactor(backend): delete RunnerRegistry, dispatcher, runner-workspace"
```

### Task 31: Update barrel exports (harness, tools-common, core)

Clean up any remaining references to deleted files in index.ts files.

```bash
bun run typecheck && bun run lint
# Fix any broken imports
git add -A
git commit -m "chore: clean up barrel exports after old code deletion"
```

### Task 32: Clean up root package.json

Remove workspace references to deleted packages, remove any scripts referencing runner-daemon.

```bash
git add package.json
git commit -m "chore: remove deleted packages from workspace config"
```

---

### Task 34: Runtime-observability — remove runner references

**Files:**
- Modify: `packages/runtime-observability/src/` (whatever package/module holds span names and service names)

- [ ] **Step 1: Remove "runner-daemon" service name**

Search for and remove any `serviceName: "runner-daemon"` constant.

- [ ] **Step 2: Remove runner-related span names**

Delete spans like `runner_heartbeat`, `runner.transport`, `daemon_health`.

- [ ] **Step 3: Remove "runner.transport" attribute**

- [ ] **Step 4: Commit**

```bash
git add packages/runtime-observability/
git commit -m "refactor(runtime-observability): remove runner-daemon service and span names"
```

---

### Task 35: Clean up dev scripts, orphan columns, lark-bot

**Files:**
- Modify: `scripts/dev.sh`
- Modify: `apps/backend/src/features/lark-bot/registry.ts` (if applicable)

- [ ] **Step 1: Remove runner-daemon comments from dev.sh**

Search `scripts/dev.sh` for any references to `runner-daemon` or `runner` spawn commands and remove them.

- [ ] **Step 2: Note attempt.pid/heartbeat_at orphan columns**

In `apps/backend/src/features/run/entities.ts`, add a comment on `AttemptRow.pid` and `AttemptRow.heartbeatAt`:

```typescript
  /** @deprecated No longer written (AgentSession runs in-process). Kept for historical data. */
  pid?: number;
  /** @deprecated No longer written. Kept for historical data. */
  heartbeatAt?: number;
```

Do NOT drop the columns from the database — just stop writing to them. The `runner_health` table becomes dead data (no new writes, no reads).

- [ ] **Step 3: Verify lark-bot zero impact**

Check `apps/backend/src/features/lark-bot/` for any `safeRunnerAgentId` usage. If found, move to a shared util or replace with simple ID validation. The lark-bot SSE watcher and ingest paths don't depend on runner infrastructure — confirm this by checking imports.

- [ ] **Step 4: Commit**

```bash
git add scripts/dev.sh apps/backend/src/features/run/entities.ts
git commit -m "chore: remove dev.sh runner comments, mark attempt orphan columns, verify lark-bot"
```

---

## Phase 4: Architecture docs cleanup

### Task 36: Update remaining architecture docs

- [ ] `docs/architecture/backend/data-model.md` — Remove `projection_messages` table, update checkpointer to global `checkpointer.db`
- [ ] `docs/architecture/conversation/ledger.md` — Remove `buildPreloadedMessages` section, `projection_messages` references
- [ ] `docs/architecture/foundations/facts-and-projections.md` — Rewrite: Agent context from ConversationContextPlugin, no Runner
- [ ] `docs/architecture/backend/event-log.md` — Event source: AgentSession.onEvent instead of Runner Daemon
- [ ] `docs/architecture/operations/troubleshooting.md` — AgentSession in-process, checkpointer.db global, no heartbeat
- [ ] `docs/architecture/runtime/framework.md` — Remove cross-process references, Checkpointer standalone

For each doc:
- Read current content
- Remove all Runner/daemon/transport/heartbeat/AgentFS references
- Rewrite in self-contained present-tense ("The system does X", never "不再Y" or "不变")
- Verify cross-references resolve to existing pages

```bash
git add docs/architecture/
git commit -m "docs(architecture): update remaining docs for AgentSession, remove Runner references"
```

---

## Verification Checklist

After all phases complete:

- [ ] `bun run typecheck` passes across all packages
- [ ] `bun run lint` passes (Biome + ESLint)
- [ ] `bun run test` passes all tests
- [ ] No imports of `runner-protocol`, `runner-daemon`, `agent-fs` remain
- [ ] No imports of `AgentFsLike`, `AgentFsRoots`, `withWorkspace`, `SandboxError` remain
- [ ] No references to `RunnerRegistry`, `RunnerDaemon`, `RunDispatcher`, `runner-workspace` remain
- [ ] `grep -r "forkRun" --include="*.ts"` returns no results
- [ ] `grep -r "buildPreloadedMessages" --include="*.ts"` returns no results
- [ ] `grep -r "buildAgentSpecV2" --include="*.ts"` returns no results
- [ ] `grep -r "ThreadProjection" --include="*.ts"` returns no results
- [ ] `grep -r "不再\|不变" docs/architecture/` returns no results (self-contained doc check)
