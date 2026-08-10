# Phase 6：删除旧执行路径

## 目标

删除 clean cutover 后不再有 owner 的旧代码、表、配置和文档，使目标架构成为唯一实现路径。

本 Phase 不增加功能。

## 不兼容策略

- 不提供旧 checkpoint 导入工具。
- 不提供旧 session ID redirect。
- 不保留 deprecated exports。
- 不保留旧 HTTP endpoint alias。
- 不保留旧 runtime 文档为 current。
- 旧执行缓存可以直接删除；产品事实不能删除。

## 约束

1. 只删除 Phase 5 已无 callsite 的旧路径。
2. Conversation History、Agent Context、Agent Run 和仍有 reader 的 audit 数据不能删除。
3. 删除旧 cache 后，下一 Agent Run 必须能仅凭 Product facts 启动。
4. 不新增替代功能，不修改已冻结的 Agent Backend contract。
5. Active source、package exports、运行配置和主文档中不得留下旧执行入口。

## 删除范围

### Runtime code

- `packages/core/src/run.ts` 第二 agent loop。
- 旧 Agent facade/session SDK 残留。
- flat checkpoint messages/interrupts/event log ownership。
- legacy Product runtime plugins。
- unused compatibility types/tests/exports。

### Backend code

- checkpointer bootstrap/settings exposure。
- checkpoint-events-store 产品依赖。
- member session binding column/API。
- legacy span/attempt terminal authority。
- old resume/interrupt endpoints。

### Packages

删除已经失去用途的 plugin package；保留仍被 Coding Agent 静态 Plugin 使用的 package。删除前用 package import graph 验证真实 callsite，不保留空壳 package。

### Data

保留：

- Conversation History
- Agent Context
- Agent Run
- audit 中仍有价值的 span/attempt records

删除：

- checkpointer.db
- checkpoint_messages
- checkpoint_interrupts
- 不再读取的 checkpoint_events

不将这些数据转换成 Agent Context。

### 文档

- 旧 runtime/framework/harness 页面改为 deprecated tombstone 或删除。
- Coding Agent 和 AgentBackend 页面成为唯一主线。
- 更新 README、index.llm、map、concepts.json、settings/operations 文档。

## 实现步骤

1. 用 import/reference search 列出所有 legacy symbol。
2. 删除无 callsite exports 和 package dependencies。
3. 删除 checkpointer DB 初始化、配置字段和诊断 API。
4. 新 migration 删除 member.session_id 和确认无用的旧表；audit 表仅在有新 reader 时保留。
5. 删除旧 API routes/DTO；同步更新 Web/Lark client。
6. 删除或标 tombstone 旧文档。
7. 清理 package.json/turbo dependency graph。
8. 格式化并顺序运行全量门禁。

## 验收

### 搜索为零

```text
checkpointer.db
checkpoint_messages
checkpoint_interrupts
createAgentSession
SessionManager
AgentHooks
runtimeSessionId
ProductTurn
SelfHosted
```

允许 migration/tombstone 中出现历史名，但 active source 和主文档不得出现。

### 数据

- 新库不创建 checkpoint tables。
- 旧库升级后产品事实完整。
- 删除旧 cache 不影响 Conversation replay 或下一 Agent Run。

### 全量门禁

顺序执行：

```text
bun run build
bun run typecheck
bun run lint
bun test
bun run test
```

### Smoke test

```text
start backend + coding-agent daemon
→ post Conversation Message
→ create Agent Run
→ Worker model/tool loop
→ transient events
→ atomic Ledger + Agent Context commit
→ stop Worker
→ next Run resume/rebuild by binding
```

再验证：

- Daemon unavailable 时 Product Backend 返回明确 failed/unsupported。
- Worker crash 不影响其他 session。
- Product Tools 权限与审计存在。
- Backend restart 后 queue/commit_failed 可恢复。

## 完成条件

仓库中只有一套 Product execution control plane 和一套 Coding Agent Runtime。旧 session/checkpoint 机制完全消失，没有兼容层或双真源。
