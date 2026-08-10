# Agent Runtime Backend Adoption Implementation Plan

> **For agentic workers:** 本计划只迁移 backend 的 Agent caller。不要在本计划内引入 Capability、拆分 `conversation-compose.ts`、修改数据库 schema 或删除旧包。
>
> **Goal:** 在 Runtime Foundation 完成后，让 backend 的 Conversation、Resume、Cron、Loop、Skill Pack 入口使用 `@my-agent-team/agent`，保持现有行为。
>
> **Architecture:** 逐个垂直切片迁移 caller。每个切片独立 typecheck/test/build；不做新旧 Agent 双写。Session 绑定、Span/Origin、ledger projection、retry、interrupt 和 cleanup 语义保持不变。
>
**Contract:** [`2026-07-23-agent-runtime-contract.md`](../specs/2026-07-23-agent-runtime-contract.md)

**Prerequisite:** [`2026-07-23-agent-runtime-foundation.md`](./2026-07-23-agent-runtime-foundation.md) P0-P4 and P4R Agent runtime completion are complete. The current branch contains partial import migration; that work is not accepted until the caller-specific gates below pass.

---

## 0. Shared migration rules

### Allowed global changes

只有 integration owner 可以修改：

```text
apps/backend/package.json
bun.lock
```

Caller agents 不得并行修改这些文件。

### Forbidden changes for every caller task

```text
packages/framework/**
packages/harness/**
apps/backend/src/capabilities/**
database schema/migrations
packages/api-contract/**
apps/web/**
apps/lark-bot/**
AgentEvent payload schema
```

### Required checks

每个 task 按顺序执行：

```text
scoped test
→ apps/backend typecheck
→ affected package/build
→ import grep
```

不得用 `any`、`@ts-ignore` 或宽泛 `as` 绕过新 API。

## 1. Conversation caller

### Files

- Modify: `apps/backend/src/features/conversation/conversation-compose.ts`
- Modify only if compile requires: `apps/backend/src/features/conversation/service.ts`
- Test: `apps/backend/src/features/conversation/*.test.ts`
- Dependency update by integration owner: `apps/backend/package.json`

### Required change

Replace backend conversation usage of `AgentSession` and `SessionManager` with the public API from `@my-agent-team/agent`.

Preserve:

- `member.sessionId` binding.
- `sessionManager.open/create/get/dispose` semantics.
- steering and follow-up routing.
- interrupt resume lookup.
- message/message_update projection.
- same `messageId` revision identity.
- terminal projection and ConversationLock release.
- agent origin and surface values.

### Non-goals

- Do not split `conversation-compose.ts`.
- Do not introduce Capability.
- Do not migrate plugins.
- Do not change AgentEvent payloads.
- Do not rename Checkpointer/ContextStore.
- Do not modify database schema.

### Acceptance

```bash
bun test apps/backend/src/features/conversation
bun run --cwd apps/backend typecheck
```

Structural check:

```bash
! grep -R '@my-agent-team/harness' apps/backend/src/features/conversation --include='*.ts'
```

Behavior checks:

```text
first message creates and binds a session
second message reopens the same session
member.sessionId survives process-reconstruction test
running prompt routes to steering
follow-up queues correctly
compaction still emits expected events
```

## 2. Resume / Span caller

### Files

- Modify: `apps/backend/src/features/span/http.ts`
- Modify only if compile requires: `apps/backend/src/features/span/supervisor.ts`
- Test: `apps/backend/src/features/span/*.test.ts`

### Required behavior

```text
spanId → sessionId lookup
sessionManager.get only; never create on resume
live Agent.resume(command)
missing span → 404
missing live Agent → 409
interrupt consumed once
```

### Non-goals

- Do not redesign SpanSupervisor.
- Do not move span ownership.
- Do not change run DB schema.

### Acceptance

```bash
bun test apps/backend/src/features/span
bun run --cwd apps/backend typecheck
```

## 3. Cron caller

### Files

- Modify: `apps/backend/src/features/cron/scheduler.ts`
- Test: `apps/backend/src/features/cron/*.test.ts`

### Required behavior

```text
cron creates isolated Agent
prompt starts with correct model/tools/plugins
origin includes cronJobId
watchdog timeout cancels correct span
retry chain remains single-flight
session is eventually disposed
```

### Non-goals

- Do not change cron state machine.
- Do not change watchdog timing semantics.
- Do not migrate cron plugin assembly to Capability.

### Acceptance

```bash
bun test apps/backend/src/features/cron
bun run --cwd apps/backend typecheck
```

## 4. Loop caller

### Files

- Modify: `apps/backend/src/features/loop/loop-step.ts`
- Modify only if compile requires: `apps/backend/src/features/loop/loop-service.ts`
- Test: `apps/backend/src/features/loop/*.test.ts`

### Required behavior

```text
generator and evaluator use independent sessions
evaluator timeout is preserved
verdict fallback is preserved
budget usage is recorded
git denylist/reset behavior is preserved
sessions are disposed
```

### Required audit

Check usage timing around `dispose()`:

```text
If getUsage() depends on a live session, read usage before dispose.
If usage is persisted, prove the persisted read path with a test.
Do not silently keep a broken dispose → getUsage order.
```

### Acceptance

```bash
bun test apps/backend/src/features/loop
bun run --cwd apps/backend typecheck
```

## 5. Skill Pack caller

### Files

- Modify: `apps/backend/src/features/skill-pack/install-session.ts`
- Test: `apps/backend/src/features/skill-pack/*.test.ts`

### Required behavior

```text
zip buffer staging and cleanup
install/sync status transitions
progressive skill plugin setup
failure fallback to failed status
session prompt completion
```

### Non-goals

- Do not change skill pack state model.
- Do not move skill tools into Capability.
- Do not change temporary file naming contract unless tests prove a bug.

### Acceptance

```bash
bun test apps/backend/src/features/skill-pack
bun run --cwd apps/backend typecheck
```

## 6. Adoption integration gate

After all five caller tasks are merged:

```bash
! grep -R '@my-agent-team/harness' apps/backend/src --include='*.ts'
bun run --cwd apps/backend typecheck
bun run build
bun run test
```

The only allowed remaining `harness` references are explicitly documented migration compatibility files, if any. No new backend feature may import `harness` after this gate.

Required smoke tests:

```text
Conversation first/second message
Conversation after process reconstruction
Interrupt + resume approved/rejected
Cron timeout/retry
Loop generator/evaluator/timeout/budget
Skill install zip/sync/failure
```

## 7. Rollback

Each caller is independently reversible by restoring its old imports and construction calls. No database migration is permitted in this workstream, so rollback is code-only.
