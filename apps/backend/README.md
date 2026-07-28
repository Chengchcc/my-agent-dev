# backend

基于 Bun 的有状态后端服务。暴露 HTTP/SSE API，管理 agent 生命周期、承载多方 conversation、编排 agent 执行（run）。Agent 在进程内直接执行，不再需要独立 runner 进程。Web 控制台和 Lark bot 通过它读写状态、发起运行、订阅事件。

## 它做什么

- **Agent CRUD 与身份**：创建、查询、更新、归档 agent。管理 model 配置、permission mode、maxSteps，以及 SOUL / USER / memory 等身份内容。
- **Conversation**：多个 member（人或 agent）共享的 conversation ledger。负责 ledger 追加、成员管理、@mention 触发、conversation 并发锁（ConversationLock）。
- **Run 编排**：`run-executor.ts` 为三条启动路径（conversation / orchestrator / cron）提供统一执行器 `executeAgentRun`。fire-and-forget 异步执行，完成信号统一经 `supervisor.notifyRunComplete` 分发。
- **RunSupervisor**：跟踪 run/attempt 行，提供 `onRunMessage` / `onRunEvent` / `onRunComplete` 回调。reaper 回收进程重启后的孤儿 DB 行。
- **SSE 推送**：conversation 的 ledger SSE 是用户可见输出的唯一通道。assistant 消息经 `session.subscribe` 直写 ledger，前端按 `messageId` upsert。run 执行细节走 EventLog（仅非 message 事件）。
- **运行时观测（ops）**：run 诊断、健康状态、trace 与 surface 状态，供控制台查询。

## 代码组织

代码按 feature 分域在 `src/features/` 下。域包括 `agent`、`conversation`、`run`、`runtime-ops`、`issue`、`orchestrator`、`cron`、`lark-bot`。

组合根 `src/main.ts` 加载配置、打开 DB、构造各域 adapter 和 service，用闭包把跨域协作接在一起，组装 HTTP 路由。各域之间只通过 interface 和注入的 callback 交互。

Run 执行：`run-executor.ts` 统一驱动 Conversation / Issue / Cron 三条路径。每条路径调用 `supervisor.startMainRun` 建行后，`executeAgentRun` 创建 Agent 并 fire-and-forget 执行。完成信号经 `notifyRunComplete` 统一触发投影与锁释放。
