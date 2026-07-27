# Agent Runtime Plugin-First Migration Plan
> **状态: P7 已完成，作为历史记录保留。Capability/AgentExtension 已在 P8 删除。**

> **For agentic workers:** 当前不把普通 Plugin 包装成 Capability。P6 已完成 Agent SDK、ModelRuntime 和 Plugin assembly；本计划把现有静态 Plugin 迁移到 `createAgentSession({ plugins })`。

**Goal:** 统一所有 Agent 创建入口，复用现有 Plugin 行为，不引入第二套 Capability/AgentExtension runtime。

**Architecture:**

```text
backend 构造 Plugin options
  → createAgentSession({ model, modelRuntime, plugins, tools, sessionManager })
  → Agent
```

`CapabilityRegistry` 已在 P8 删除。以下内容记录当时 P7 执行步骤。所有关于未来 Capability wrapper/catalog 的内容已作废；当前架构以 ADR 0016 和 runtime contract 为准。

**Contract:** [`2026-07-23-agent-runtime-contract.md`](../specs/2026-07-23-agent-runtime-contract.md)

## Prerequisites

- P4R complete.
- P5A-E Backend Adoption complete.
- P6-A Plugin assembly complete.
- P6-B service ownership boundaries documented; no ordinary Plugin depends on it.
- P6-C `createAgentSession()` integration test passes.
- `bun run build` and affected package typechecks pass.

## 1. SDK Plugin input gate

Verify `createAgentSession()` supports:

```ts
createAgentSession({
  model,
  modelRuntime,
  plugins,
  tools,
  sessionManager,
  sessionId,
});
```

It must resolve the model, preserve Plugin order, merge Plugin tools, reject tool collisions, inject persistence, and return Agent.

### Acceptance

```bash
bun run build
bun run --cwd packages/agent typecheck
bun test packages/agent
bun run --cwd apps/backend typecheck
```

## 2. P7-1 Conversation Plugin-first migration

### Files

- Modify: `apps/backend/src/features/conversation/conversation-compose.ts`
- Modify: `apps/backend/src/features/span/agent-helpers.ts` only for shared Plugin factory/model runtime wiring
- Test: affected conversation tests

### Required change

Replace direct `sessionManager.open/create(agentConfig)` with `createAgentSession()` while preserving the existing Plugin list:

```text
defaultPlugins
conversationContextPlugin
goalPlugin
petPlugin
recapPlugin
memoryPlugin
```

The first migration may keep these as static Plugins. Do not wrap them as Capability or AgentExtensionFactory.

### Preserve

- `member.sessionId` binding.
- Conversation tools and MCP tools.
- Model provider/model selection.
- Context pipeline and metaContext.
- Steering/follow-up.
- Message projection and ConversationLock.

### Acceptance

```bash
bun test apps/backend/src/features/conversation
bun run --cwd apps/backend typecheck
```

Structural check:

```bash
! grep -n 'new Agent\|sessionManager\.\(open\|create\)(agentConfig' \
  apps/backend/src/features/conversation/conversation-compose.ts
```

## 3. P7-2 Cron / Loop / Skill Pack migration

Migrate each caller independently:

```text
cron scheduler
loop generator/evaluator
skill-pack install/sync
```

Each uses `createAgentSession({ plugins })`. Do not change plugin behavior or database schema.

### Acceptance

```bash
bun test apps/backend/src/features/cron
bun test apps/backend/src/features/loop
bun test apps/backend/src/features/skill-pack
bun run --cwd apps/backend typecheck
```

## 4. Plugin package migration rules

Keep these packages as static Plugin implementations during P7:

```text
plugin-identity
plugin-progressive-skill
plugin-conversation-context
plugin-todo
plugin-goal
plugin-pet
plugin-recap
plugin-memory
```

Do not create a new `apps/backend/src/capabilities` directory.


## 5. P7 workstream gate

```bash
bun run build
bun run --cwd packages/agent typecheck
bun test packages/agent
bun run --cwd apps/backend typecheck
bun test apps/backend/src/features/conversation
bun test apps/backend/src/features/cron
bun test apps/backend/src/features/loop
bun test apps/backend/src/features/skill-pack
```

Structural checks:

```bash
! git grep -n 'CapabilityRegistry\|AgentExtensionFactory\|ExtensionHost' -- apps/backend/src packages/agent/src
```

P7 gate meaning: the production callers use `createAgentSession({ plugins })`; capability catalog code is not part of the ordinary Agent path. A future Capability wrapper may exist only for a feature that also owns backend services/routes/surface metadata.

## 6. Rollback

Rollback is per caller:

```text
createAgentSession() → restore existing SessionManager + AgentConfig path
```

Do not run old and new Agent paths for the same input. Do not modify database schema.

## 7. Deferred Pi-style Extension

Dynamic `jiti` extensions are a separate future plan. They are not required for P7 and must not be introduced as a workaround for static Plugin migration.
