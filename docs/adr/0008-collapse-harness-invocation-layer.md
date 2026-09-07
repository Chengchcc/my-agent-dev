# ADR 0008: 塌缩 harness 调用层：删除 SessionSpec / SessionFactory / executeAgentRun

> ✅ **已实施(2026-08-13)**：SessionSpec/SessionFactory/executeAgentRun 已全部删除(Phase 5/6，packages/harness 退役，apps/oh-my-agent 以 createOmaRuntime 单入口取代)。本文档从提案转为实施记录。

## 状态

Implemented(was Proposed)

## 上下文

当前 backend 调用 harness 有层层间接：

```
executeAgentRun()        ← 顶层：DB 追踪 + 构建 config + 跑 agent
  → buildSessionSpec()   ← 中层：组装 config（改名为 SessionSpec）
    → SessionFactory.getOrCreate(SessionSpec)
      → new AgentSession(AgentSessionConfig)  ← 底层
```

问题：

1. **`SessionSpec` 是跨进程 contract 残留。** 旧架构中 backend 和 runner 是不同进程，spec 需要序列化。现在同进程，`SessionSpec` 只是 `AgentSessionConfig` 加两个 AgentSession 不用的字段（`agentId`、`cwd`）。
2. **`SessionFactory` 也是跨进程残留。** 旧架构要分配 session 到不同 runner 进程，需要 factory 管理生命周期。现在同进程，`new AgentSession(config)` 足够。idle reaping 和 concurrency serialization 不由 factory 提供更合适。
3. **`buildSessionSpec` 尝试统一 config**，但 loop 和 install 的工具/插件完全不同，走不进来。
4. **`executeAgentRun` 绑定正交职责**：DB 追踪和跑 agent 绑在一个函数里。
5. **`sessionId` 被领域语义渗透**：conversation 把 `conversationId:memberId` 编码进 sessionId，再用 `parseSessionId()` 拆回来。底层概念不应该知道上层的领域对象。
6. **四个 feature 做同样的事**：构建 config → 创建 AgentSession → prompt() → dispose()——但用了四种不同路径。

## 决策

**塌缩所有中间层。** 所有 feature 走同一条最短路径：

```ts
const session = new AgentSession({ sessionId: ulid(), model, tools, plugins, ... });
await session.prompt(input);
session.dispose();
```

### 概念重新分层

```
L1 领域层 — conversationId, issueId, cronJobId, loopId
    — 不编码进技术 ID

L2 Session 层 — sessionId = ULID
    — AgentSession 自生成，不携带领域语义
    — checkpointer key（消息历史）
    — conversation: (conversationId, agentMemberId) → sessionId 存在 DB，跨请求复用
    — cron/orchestrator/loop: 每次新 session

L3 追踪层 — spanId = tracePlugin.beforeRun 生成
    — 一次 prompt()/resume() 的执行记录
    — span(spanId, sessionId, kind, originRef) 表跨层映射 L3→L2→L1
```

### 删除

| 删除 | 理由 |
|------|------|
| `SessionSpec` 类型 | `AgentSessionConfig` 别名 |
| `SessionSpecMismatchError` | 跟着死 |
| `SessionFactory` 全部 | 跨进程残留，`new AgentSession()` 直接替代 |
| `session-factory.ts` | 整个文件 |
| `buildSessionSpec()` | 每个 feature 自己构建 config |
| `executeAgentRun()` | 职责拆入 `tracePlugin` + 直接 `session.prompt()` |
| `makeRunDeps()` | struct builder，无价值 |
| `RunDeps` / `RunRequest` / `SpanOrigin` | 跟着死 |
| `span-executor.ts` | 整个文件 |
| `parseSessionId()` | sessionId 不再编码领域语义 |
| `deriveSessionId()` | 同上 |
| `traceId` 列 | 空占位，无 OTel 集成 |

### 新增

| 新增 | 位置 |
|------|------|
| `tracePlugin({ opsStore, supervisor })` | `packages/plugin-trace/` |
| `conversation_session` 表 | `schema.ts` — `(conversationId, agentMemberId) → sessionId` |

### 保留

| 保留 | 理由 |
|------|------|
| `SpanSupervisor` | DB span/attempt CRUD（给 tracePlugin 用） |
| `RuntimeOpsStore` | span_origin 写入（给 tracePlugin 用） |
| `resumeRoutes` | `session.resume()` 替代 `factory.peek` |

### 各 Feature 统一路径

```
conversation:  (cid, memberId) → DB 查/创建 sessionId → new AgentSession(sid) → prompt()
cron:          ULID sessionId → new AgentSession(sid) → prompt() → dispose()
loop:          ULID sessionId × 2 → new AgentSession(sid) → prompt() → dispose()
```

差异仅在 conversation 多一步 DB 查 sessionId。

## 后果

+ 删除 ~600 行间接层代码（session-factory.ts + span-executor.ts + 相关类型）
+ `parseSessionId()` / `deriveSessionId()` 删除：跨层映射存 DB，不编码在 ID 里
+ `traceId` 列从 `span_origin` 表删除（空占位，OTel 后需要时再加）
+ tracePlugin 让"追踪"显式可选：不在 plugins 数组里就不追踪
+ resume 极简：`spanId → DB 查 sessionId → live session → session.resume(cmd)`

## 关联

+ [设计哲学 §2](http://docs/architecture/design-philosophy.md) — 暴露业务，隐藏机制
+ [设计哲学 §3](http://docs/architecture/design-philosophy.md) — 统一本体，不复制语义
+ [ADR 0007](./0007-span-canonical-run-user-facing.md) — span/run 术语收敛
