# Phase 5：所有 Product Flow 使用 Agent Run

## 目标

把 Product Backend 所有 Agent 执行入口一次性迁移到统一 Agent Run creation/execution，并删除 Backend 内旧执行路径。

这是唯一业务切流 Phase。迁移不考虑旧 session 连续性；切流时旧 execution session 全部失效。

## 不兼容策略

- 不继续旧 Agent Run。
- 不 resume 旧 checkpointer session。
- 不保留 ConversationLock/activeSessions fallback。
- 不保留 direct prompt/steer/followUp/compact。
- 不双写 Live Updates 与 Conversation History。
- 不为旧 span/run HTTP API 提供兼容返回；API contract 同步切换为 Agent Run。

## 约束

1. Conversation、Cron、Loop、Skill Pack installer 和所有临时 Agent 必须迁移。
2. 每个 caller 必须先得到稳定 scope：Conversation + Agent Member + Context Branch。
3. Surface 只消费 Conversation History canonical Message + Live Updates。
4. Ops 从 Agent Run + audit 读状态，不从 checkpoint event 推断终态。
5. 切流完成后 `apps/backend` 不依赖 `@my-agent-team/agent`。

## 实现步骤

### A. Conversation

修改：

```text
apps/backend/src/features/conversation/service.ts
apps/backend/src/features/conversation/conversation-compose.ts
apps/backend/src/features/conversation/http.ts
apps/backend/src/features/conversation/ports.ts
apps/backend/src/features/conversation/adapter-sqlite.ts
```

删除：

```text
conversation/lock.ts
conversation/agent-factory.ts
conversation/agent-projection.ts
conversation/run-accumulator.ts
```

新流程：human Ledger → branch/run acquire → Pool dispatch → transient stream → terminal atomic commit。

Busy input 只进入 persistent normal/steer/follow_up queue。

### B. Cron

`cron/scheduler.ts` 使用 Agent Run Scope 获取稳定 headless scope，然后创建 Agent Run。不创建 Runtime session。

### C. Loop

`loop-service.ts`、`loop-step.ts` 的 Generator/Evaluator 各自通过 Product Agent + Context Branch 创建 Run。不依赖 AgentConfig/SessionManager/createAgentSession。

### D. Skill Pack installer 和临时 Agent

搜索所有 `createAgentSession()`/`new Agent()` caller。每个 caller 二选一：

- 属于 Product Agent：使用 headless scope + Pool；
- 不是 Product Agent：改为普通 deterministic service，不再伪装成 Agent session。

### E. Ops

- Agent Run 决定状态和 terminal。
- span/attempt/control-plane event 只作为 audit。
- 删除 checkpoint-events-store 作为产品状态来源。

### F. Web/Lark/API

- streaming event 从 Backend transient channel 获取。
- final Message 从 Ledger 获取。
- busy/waiting/failed 使用 Agent Run status。
- 不消费 Coding Agent 私有事件决定业务状态。

### G. Composition

修改 bootstrap/services/features/main：

- 注入 Registry、Pool、Context/Run services、CodingAgentBackend client。
- 删除 SqliteSessionManager、checkpointer.db、direct model/runtime assembly。
- shutdown 时关闭 Pool/Adapter/Daemon client。

## 验收

### 静态 clean gate

以下搜索为零：

```text
@my-agent-team/agent in apps/backend
createAgentSession in apps/backend
SessionManager in apps/backend
ConversationLock
activeSessions
direct .prompt/.steer/.followUp/.compact
member.sessionId
checkpointer.db as Product state
```

### 行为

- Web message 完成 Agent Run，最终 Message 只在 terminal commit 后出现。
- busy normal/steer/follow_up 在 restart 后保持。
- Cron restart 后使用同一 headless branch。
- Loop Generator/Evaluator 有独立稳定 scope。
- Skill Pack installer 不绕过 Pool。
- Worker crash 显示 failed，不显示 succeeded。
- commit_failed 不释放 branch。
- Lark/Web 断线不影响 canonical result。

### 门禁

先顺序执行 scoped backend tests，再执行 backend typecheck/lint。由于旧 `packages/agent` API 已在 Phase 2 删除，本 Phase 完成前全仓 build 失败是 programme 内预期；本 Phase 必须恢复全仓编译。

## 完成条件

所有 Product caller 已切到 AgentBackend。Backend 不再知道 Coding Session、Agent Loop、Provider SDK 或 Runtime persistence。
