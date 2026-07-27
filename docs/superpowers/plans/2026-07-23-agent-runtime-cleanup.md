# Agent Runtime Structural Cleanup Implementation Plan

> **For agentic workers:** P4R Agent runtime completion is part of Foundation and must pass before this plan starts. This plan is structural cleanup only: composition split, bootstrap split, naming cleanup, and old package deletion. It must not introduce new Agent behavior.

> **Goal:** 将已经验证过的 Agent/Plugin 行为整理为最终边界，删除旧业务引用和临时适配层。

> **Architecture:** Cleanup 是最后阶段，不与行为迁移并行。先拆职责，再做单项 rename，最后删除 framework/harness。普通 Agent 功能保持 Plugin-first；未来跨边界 Capability 和动态 Extension 另开计划。

> **Contract:** [`2026-07-23-agent-runtime-contract.md`](../specs/2026-07-23-agent-runtime-contract.md)

> **Prerequisites:**
>
> - Foundation P0-P4 and P4R Agent runtime completion pass.
> - Backend Adoption complete.
> - P6-A/P6-B/P6-C complete.
> - P7 Plugin-first migration complete.
> - Affected backend/agent tests must pass before cleanup starts. Known Darwin setsid test failures are not P8 regressions — record separately..

---

## 0. Cleanup baseline

### Acceptance before edits

```bash
bun run build
bun run typecheck
bun run test
```

Record the clean baseline for this workstream. No cleanup starts against an unverified runtime.

## 1. Split conversation composition

### Files

- Create: `apps/backend/src/features/conversation/agent-factory.ts`
- Create: `apps/backend/src/features/conversation/agent-projection.ts`
- Modify: `apps/backend/src/features/conversation/conversation-compose.ts`
- Tests: `apps/backend/src/features/conversation/*.test.ts`

### Responsibilities

#### `agent-factory.ts`

- Resolve model through SDK ModelRuntime.
- Build base tools.
- Use `createAgentSession()` for Agent construction.
- Keep static Plugin option creation outside the generic SDK composer.

Must not write ledger or release ConversationLock.


#### `agent-projection.ts`

- `message` / `message_update` → ledger revision.
- `todo_update` → run accumulator.
- `pet_bark` / `recap_update` → Conversation-visible projection.
- terminal revision → title/mention/lock handling.
- projection error → degraded run handling.

Must not create models or Agent instances.

#### `conversation-compose.ts`

Only feature-level service wiring and composition.

### Acceptance

```bash
bun test apps/backend/src/features/conversation
bun run --cwd apps/backend typecheck
```

Structural checks:

```bash
! grep -n 'createModel\|petPlugin\|recapPlugin\|memoryPlugin\|goalPlugin' \
  apps/backend/src/features/conversation/conversation-compose.ts
```

Behavior checks:

```text
message revision identity unchanged
terminal projection still releases lock
projection failure still marks degraded state
resume finds same live Agent
queue_update remains transient
```

## 2. Backend bootstrap split

### Files

- Create: `apps/backend/src/bootstrap/services.ts`
- Create: `apps/backend/src/bootstrap/features.ts`
- Modify: `apps/backend/src/main.ts`
- Modify: `apps/backend/src/app.ts`
- Tests/smoke: `apps/backend/src/**/*.test.ts`

### Target responsibility

`main.ts` may contain:

```text
config loading
database opening
core infrastructure creation
Services creation
feature installation
app creation
server/scheduler start
shutdown handlers
```

`main.ts` must not directly contain:

```text
pet/recap/memory/goal plugin assembly
conversation Agent config construction
per-feature Agent model/plugin wiring
```

Do not hide DB/server/scheduler initialization behind an opaque `backend.install()` that merely moves the monolith.

### Acceptance

```bash
bun run --cwd apps/backend typecheck
bun test apps/backend/src
bun run build
```

Smoke test:

```text
/health
conversation route
resume route
cron scheduler startup
loop route
skill-pack route
```

## 3. One-at-a-time naming migration

Each item below is a separate task and separate gate:

```text
AgentSession → Agent
PluginHooks → AgentHooks
HookContext → AgentContext
SessionConfig → AgentConfig
ContextStore → RunState (only after typed context contract is stable)
Checkpointer → SessionStore (only after persistence boundary is explicitly implemented)
```

### Required process for each rename

1. Use LSP references for the symbol.
2. Update definition and all callsites.
3. Update tests and package barrels.
4. Run affected package typecheck.
5. Run affected tests.
6. Grep old symbol.
7. Review diff for semantic changes.

### Forbidden

- Do not combine multiple renames in one task.
- Do not change persistence schema during naming migration.
- Do not add aliases or deprecated re-exports as permanent API.
- Do not use text replacement for cross-file symbol rename when LSP is available.

### Checkpointer rule

Do not mechanically rename `Checkpointer` until the implementation clearly separates:

```text
session message/interrupt persistence
run audit event persistence
```

Existing SQLite tables and file formats stay compatible. A schema migration is a separate task if required.

## 4. Remove compatibility paths

### Preconditions

```bash
! grep -R '@my-agent-team/harness' packages apps --include='*.ts'
! grep -R '@my-agent-team/framework' packages apps --include='*.ts'
```

If either command finds a business caller, stop. Do not delete the package.

### Files

- Modify/delete: `packages/harness/**`
- Modify/delete: `packages/framework/**`
- Modify: package manifests and `bun.lock`
- Update: package README files and architecture docs

### Deletion order

```text
remove harness business imports
→ remove harness package
→ remove framework business imports
→ remove framework package
→ update workspace lockfile
```

Do not delete both packages in the same change unless the dependency graph and full build are already proven.

### Acceptance

```bash
bun install
bun run build
bun run typecheck
bun run lint
bun run test
```

Structural checks:

```bash
! grep -R '@my-agent-team/harness' packages apps --include='*.ts'
! grep -R '@my-agent-team/framework' packages apps --include='*.ts'
```

## 5. Documentation update

Update only after code behavior is verified:

```text
packages/README.md
docs/architecture/runtime/framework.md
docs/architecture/runtime/plugin.md
docs/architecture/harness/harness.md
docs/architecture/backend/conversation-projection.md
docs/architecture/foundations/lifecycle-overview.md
docs/adr/0016-agent-runtime.md
```

Add if needed:

```text
docs/architecture/runtime/agent.md
```

Documentation main line:

```text
Agent produces Message.
Conversation stores Message.
Surface renders Message.
```

Do not make checkpoint/audit/projection internals the primary user-facing story.

## 6. Final end-to-end verification

### Build and static checks

```bash
bun run build
bun run typecheck
bun run lint
```

### Tests

```bash
bun run test
```

### Smoke paths

```text
Conversation first and second message
Conversation after process reconstruction
steering and follow-up
Interrupt + resume approved/rejected
retry success and retry exhaustion
auto/manual compaction
Cron timeout/retry/single-flight
Loop generator/evaluator/timeout/budget/rollback
Skill install zip/sync/failure cleanup
```

### Final go/no-go

Go only if:

```text
[ ] no business import of framework/harness remains
[ ] no permanent compatibility alias remains
[ ] no unreviewed database migration exists
[ ] Agent behavior tests pass
[ ] persistence recovery passes
[ ] projection invariants pass
[ ] Plugin assembly boundaries pass
[ ] full CI passes
[ ] smoke paths pass
```

## 7. Rollback

Before deleting either old package, create a reviewable checkpoint with full build/typecheck/test passing. If cleanup fails, restore the last checkpoint; do not reintroduce partial aliases or leave both old and new public APIs indefinitely.
