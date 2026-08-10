# Agent Runtime Foundation Implementation Plan

> **For agentic workers:** 按 task 顺序执行。每个 task 独立 review、独立验证；不要跨 task 提前清理。
>
> **Goal:** 建立 `@my-agent-team/agent`，承接当前 `AgentSession + SessionManager` 的 observable behavior，并冻结 AgentHooks 边界；迁移期间内部暂时复用 `@my-agent-team/framework`。
>
> **Architecture:** 新 Agent 是 lifecycle facade，不是从 `core.run()` 重新实现一套 runtime。第一阶段保留 framework 的执行循环、存储和 context 实现，由新包封装 Agent 生命周期。完成后 backend caller 才开始迁移。
>
> **Tech Stack:** Bun、TypeScript NodeNext、bun:test、`@my-agent-team/core`、`@my-agent-team/framework`、`@my-agent-team/message`。
>
> **Contract:** [`2026-07-23-agent-runtime-contract.md`](../specs/2026-07-23-agent-runtime-contract.md)
>
> ---

## 0. Baseline

### Files

- Read: `packages/framework/src/agent-event.ts`
- Read: `packages/framework/src/agent-options.ts`
- Read: `packages/framework/src/plugin.ts`
- Read: `packages/framework/src/create-agent.ts`
- Read: `packages/harness/src/agent-session.ts`
- Read: `packages/harness/src/session-manager.ts`
- Read: `packages/harness/src/agent-session.test.ts`

### Steps

- [ ] Run `bun run build` and record output.
- [ ] Run `bun run typecheck` and record output.
- [ ] Run `bun run test` and record output.
- [ ] Record pre-existing failures; do not relabel them as migration regressions.

### Gate

No implementation starts until baseline is recorded. If baseline is red, every later gate must report `new failures = 0`.

## 1. Create package skeleton

### Files

- Create: `packages/agent/package.json`
- Create: `packages/agent/tsconfig.json`
- Create: `packages/agent/tsconfig.test.json`
- Create: `packages/agent/src/index.ts`
- Create: `packages/agent/src/agent.ts`
- Create: `packages/agent/src/agent-options.ts`
- Create: `packages/agent/src/agent-events.ts`
- Create: `packages/agent/src/agent-hooks.ts`
- Create: `packages/agent/src/session-manager.ts`
- Create: `packages/agent/src/compaction.ts`
- Create: `packages/agent/src/run-state.ts`
- Create: `packages/agent/src/session-store.ts`

### Required dependencies

First phase may depend on:

```json
{
  "@my-agent-team/core": "workspace:*",
  "@my-agent-team/framework": "workspace:*",
  "@my-agent-team/message": "workspace:*"
}
```

Do not depend on backend, React, Elysia, Drizzle, or feature packages.

### Acceptance

```bash
bun run --cwd packages/agent build
bun run --cwd packages/agent typecheck
bun run --cwd packages/agent test
```

Structural checks:

```bash
! grep -R 'apps/backend\|react\|React\|elysia\|drizzle' packages/agent/src
```

### Gate

New package builds independently. No existing package caller is migrated in this task.

## 2. Migrate Agent lifecycle

### Files

- Modify: `packages/agent/src/agent.ts`
- Modify: `packages/agent/src/agent-options.ts`
- Modify: `packages/agent/src/agent-events.ts`
- Modify: `packages/agent/src/compaction.ts`
- Test: `packages/agent/src/agent.test.ts`

### Required behavior

Implement the current `AgentSession` behavior:

```text
prompt
continue
resume
retry
compaction
abort
steer
followUp
dispose
waitForIdle
subscribe
getContextUsage
getUsage
```

The implementation may internally hold a framework Agent. Name the internal type `FrameworkAgent` or `CoreAgent` to avoid confusing it with the new public `Agent`.

### Non-goals

- Do not migrate backend callers.
- Do not create Capability registry.
- Do not redesign PluginHooks.
- Do not rename Checkpointer or ContextStore.
- Do not modify database schema.
- Do not delete harness/framework.

### Tests

Port the behavior coverage from `packages/harness/src/agent-session.test.ts`:

```text
success
retry failure
retry recovery
empty model response
state transitions
agent_end willRetry
dispose
context usage
auto compaction
steer
follow-up
prompt while running
interrupt/resume
plugin init
```

### Acceptance

```bash
bun run --cwd packages/agent typecheck
bun test packages/agent/src/agent.test.ts
bun run --cwd packages/agent build
bun test packages/harness/src/agent-session.test.ts
```

### Gate

New Agent tests cover the old AgentSession observable behavior. Existing harness tests still pass unchanged.

## 3. Migrate SessionManager

### Files

- Modify: `packages/agent/src/session-manager.ts`
- Create: `packages/agent/src/session-manager.test.ts`
- Read/modify only as compatibility requires: `packages/harness/src/session-manager.ts`
- Read/modify only as compatibility requires: `packages/harness/src/index.ts`

### Required behavior

```text
create() generates a unique sessionId
open() reuses live Agent on memory hit
open() restores persisted history on memory miss
dispose() calls Agent.dispose and removes live entry
caller does not create checkpointer/session storage
manager injects startSpan uniformly
```

The SQLite schema and existing files must remain compatible.

### Recovery test

Implement a deterministic test:

```text
manager1.create()
agent.prompt()
manager1.dispose()
manager2.open(sameSessionId)
agent.continue()
```

Verify prior messages remain available.

### Acceptance

```bash
bun test packages/agent/src/session-manager.test.ts
bun run --cwd packages/agent typecheck
bun run --cwd packages/agent build
bun run --cwd packages/harness typecheck
```

### Gate

Session identity and persistence are proven before any backend caller migration starts.

## 4. Add framework adapter boundary

### Files

- Create: `packages/agent/src/framework-adapter.ts`
- Test: `packages/agent/src/framework-adapter.test.ts`
- Modify: `packages/agent/src/index.ts`
- Modify: `packages/agent/src/agent-options.ts` only when needed to hide framework-only types

### Required behavior

Keep framework-only imports behind internal adapter files where practical. Backend callers must be able to construct/use Agent without importing framework directly.

### Acceptance

```bash
bun run --cwd packages/agent typecheck
bun run --cwd packages/agent build
```

Structural checks:

```bash
# framework imports may exist in internal adapter/implementation files
# index.ts must not re-export framework-only types
! grep -n 'from "@my-agent-team/framework"' packages/agent/src/index.ts
```

### Non-goals

- Do not remove framework dependency yet.
- Do not rename framework.Agent.
- Do not change framework runtime behavior.

## 5. Implement AgentHooks

### Files

- Modify: `packages/agent/src/agent-hooks.ts`
- Create: `packages/agent/src/agent-context.ts`
- Create: `packages/agent/src/hook-dispatcher.ts`
- Test: `packages/agent/src/agent-hooks.test.ts`
- Modify: `packages/agent/src/agent.ts`

### Required semantics

- Registration order is deterministic.
- `before:run` and `before:model` chain transformed output.
- `after:model`, `after:tool`, `after:turn` are observers.
- `before:tool` preserves skip/input/result/isError.
- `before:stop` preserves force-continue and maxForceContinues.
- Keep current hook error policy during migration.

### Acceptance tests

```text
hook order
before:run transformer
before:model transformer chain
before:tool input replacement
before:tool synthetic result
before:tool skip
after hook observer behavior
before:stop continuation
multiple stop decisions
maxForceContinues
hook error policy
```

### Acceptance commands

```bash
bun run --cwd packages/agent typecheck
bun test packages/agent/src/agent-hooks.test.ts
bun test packages/framework
bun run --cwd packages/framework typecheck
```

### Gate

Only after this gate may Capability code call `extendAgent()` and return AgentHooks.

## 6. P4R Agent runtime completion / framework absorption

> This task group was added after the current branch started partial backend and Capability work before Foundation gates passed. Existing Capability prototype files are paused and do not count as completed Capability migration.

P4R is four executable tasks. They remain part of Foundation because they complete the Agent public behavior contract; they must not be deferred until structural cleanup.

### P4R-1: Compact absorption

**Files:**

- Modify: `packages/agent/src/agent.ts`
- Modify or move with minimal API change: `packages/harness/src/compaction.ts` into an agent-owned module
- Modify: `packages/agent/src/compaction.ts`
- Test: `packages/agent/src/agent.test.ts`

**Required behavior:**

- Reuse the existing `compactThread()` algorithm rather than inventing a second summarizer.
- Load messages from the configured Checkpointer/SessionStore.
- Save compacted messages.
- Replace the runtime thread messages and reconcile session state.
- Emit real `compaction_start` / `compaction_end` payloads.
- Preserve original messages if compaction fails.

**Acceptance:**

```text
message count/content changes when compaction is needed
persisted messages contain the compacted result
runtime thread contains the same compacted result
failure leaves original messages intact
manual and automatic compaction use the same implementation
```

### P4R-2: Usage absorption

**Files:**

- Modify: `packages/agent/src/agent.ts`
- Modify: `packages/agent/src/session-manager.ts` only if persistence access is needed
- Test: `packages/agent/src/agent.test.ts`
- Later caller fix: `apps/backend/src/features/loop/loop-step.ts`

**Required behavior:**

- Read existing checkpoint events through `readEvents(sessionId)`.
- Sum `model_end.usage.input + usage.output`.
- Return 0 only when there are genuinely no usage events.
- Do not make usage depend on the Agent remaining in the live SessionManager map.

**Loop ordering requirement:**

```text
read usage
→ dispose Agent
```

or provide a proven persisted usage read after dispose. The current `dispose → getUsage` order is not accepted.

### P4R-3: Raw input lifecycle

**Files:**

- Modify: `packages/agent/src/agent.ts`
- Modify: `packages/agent/src/agent-hooks.ts`
- Modify: `packages/agent/src/hook-dispatcher.ts` only for message-level compatibility hooks
- Test: `packages/agent/src/agent-hooks.test.ts`

**Required semantics:**

`AgentHooks["before:run"]` is a raw input transformer:

```text
Agent.prompt(input)
  → before:run(ctx, { text: input })
  → transformed input
  → framework Agent.run(transformed input)
```

Do not map it to framework `PluginHooks.beforeRun(messages)`. The latter remains a separate message-list transformer.

Async hook results must be awaited. The transformed input must affect the model-visible user message.

### P4R-4: Turn lifecycle

**Files:**

- Modify: `packages/agent/src/agent.ts`
- Modify: `packages/agent/src/agent-hooks.ts`
- Modify: `packages/agent/src/hook-dispatcher.ts` only if needed for existing hook adapters
- Test: `packages/agent/src/agent-hooks.test.ts`

**Required semantics:**

`after:turn` means one external Agent turn, not one internal model/tool step:

```text
prompt / continue / resume
  → zero or more model/tool iterations
  → succeeded / error / interrupted
  → after:turn exactly once
```

It must fire for successful, failed, and interrupted turns according to the contract. It must not fire once per tool call.

### Shared P4R fixes

- Replace `AgentEvent = unknown` with a concrete discriminated event boundary. A framework re-export is allowed only as a temporary adapter; the public Agent package must expose typed events.
- Implement typed `setContext<T>(key: ContextKey<T>, value: T)` through the real ContextStore/RunState API; no raw `unknown` key or `as unknown as` write.
- Keep framework-only types behind the adapter and remove migration suppressions.
- Make tests fail on target behavior failures. Do not catch and accept compact/resume/usage failures without asserting the expected outcome.

### Forbidden

- Do not add new Capability wrappers.
- Do not wire the existing Capability registry into production Agent creation.
- Do not migrate pet/recap/memory.
- Do not delete framework/harness.
- Do not change database schema or checkpoint table/file formats.
- Do not use `any`, `@ts-ignore`, `@ts-expect-error`, or `as unknown as` to bypass the new boundary.

### P4R acceptance commands

```bash
bun install
bun run build
bun run --cwd packages/agent typecheck
bun run --cwd packages/agent build
bun test packages/agent
bun run --cwd packages/framework typecheck
bun test packages/framework
bun run --cwd apps/backend typecheck
```

### Structural checks

```bash
! grep -R 'AgentEvent = unknown\|return 0;\|@ts-expect-error migration' packages/agent apps/backend/src/main.ts
! grep -R 'setContext.*unknown\|as unknown as' packages/agent/src
```

### Gate

P4R is not complete until all four tasks, their behavior tests, and every command pass. Backend caller adoption and Capability production wiring remain blocked until this gate passes.

## 7. Workstream completion gate

```bash
bun run --cwd packages/agent build
bun run --cwd packages/agent typecheck
bun test packages/agent
bun test packages/framework
bun test packages/harness
bun run typecheck
```

Required report:

- changed files
- public exports
- behavior tests added
- commands and exact results
- known deviations from contract
- rollback point

No backend caller migration is included in this workstream.
