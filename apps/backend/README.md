# backend

基于 Bun 的有状态后端服务。暴露 HTTP/SSE API，管理 agent 生命周期、承载多方 conversation、编排 Agent Run 执行。Web 控制台和 Lark bot 通过它读写状态、发起运行、订阅事件。

## 它做什么

- **Agent CRUD 与身份**：创建、查询、更新、归档 agent。管理 model 配置、permission mode、maxSteps 与 workspace。
- **Conversation**：多个 member（人或 agent）共享的 conversation ledger。负责 ledger 追加、成员管理、@mention 触发与 hop control。
- **Agent Run 执行**：所有真实 Agent 执行（Conversation 回复、Cron、Loop Generator/Evaluator）统一走 `AgentRunService.enqueueAndAcquire` → `AgentRunExecutionService.dispatch`。输入先持久化（normal/steer/follow_up 队列），terminal 结果由 Agent Run 与 Conversation History 表达。执行引擎是一次性 oma 子进程（one Run / one child），Product Backend 只依赖统一 Agent Backend 协议（`@chengchenccc/agent-backend`）。
- **Product Context**：每个 agent member 一份 Agent Context（parent-linked entries 支持 branch/fork）。final assistant Message 只在 terminal commit 时写入 History + Context，原子提交。
- **Product Tools**：History 只读工具 + `history_retain` 由 Product Backend 统一执行（MCP 是接入方式，不是领域身份）。
- **SSE 推送**：conversation 的 ledger SSE 是 canonical 输出的唯一通道；Agent Run Live Updates 只供实时展示，断线可丢，不写 History。
- **运行时观测（ops）**：`/api/agent-runs` 提供 run 列表/详情/cancel/events；surface health 保留为 audit。

## 代码组织

代码按 feature 分域在 `src/features/` 下：`agent`、`conversation`、`agent-context`、`agent-run`、`product-tools`、`cron`、`loop`、`skill-pack`、`runtime-ops` 等。

组合根 `src/bootstrap/features.ts` 加载配置、打开 DB、构造各域 adapter 和 service，用闭包把跨域协作接在一起，组装 HTTP 路由。各域之间只通过 interface 和注入的 callback 交互。

## 执行模型

```text
Human Message → Conversation History（canonical）
→ trigger → AgentRunService.enqueueAndAcquire（normal/steer/follow_up 先持久化）
→ acquired → AgentRunExecutionService.dispatch(runId)
→ spawn oma --mode rpc 子进程（per-Run Runtime，in-memory SessionStore）
→ BackendRunOutcome → backend.db 原子 terminal commit（History Message + Context ref + run）
→ child 自行退出
```

- 同一 Context Branch 最多一个 active Agent Run。
- `commit_failed` 保留 branch 占用，`retryTerminalCommit` 幂等重放。
- child crash → run failed；断线/重启后 busy 队列按原顺序恢复（delivery idempotency 去重）。
- Agent Run 是唯一执行身份；无 daemon/session/span/checkpoint，不迁移旧执行路径。
