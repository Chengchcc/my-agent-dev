# Phase 0：冻结 AgentBackend Contracts

## 目标

建立唯一、可编译、与实现无关的 AgentBackend 协议。Product Backend、Coding Agent Adapter、Claude/Codex/OpenCode Adapter 和 transport 后续只能依赖这组类型通信。

本 Phase 不实现 Backend 或 Runtime。

## 不兼容策略

- 不保留旧 `Agent`、`AgentSession`、`SessionManager`、`Span` API 的别名。
- 不提供旧事件到新事件的兼容类型。
- 不把 `spanId` 伪装为 `runId`。
- 不定义 deprecated 字段或 compatibility payload。
- 旧调用方在 Phase 5 一次性迁移；本 Phase 只建立新合同。

## 约束

1. 协议包不能依赖 `apps/backend`、`packages/agent`、Provider SDK 或 HTTP framework。
2. `Message` 继续来自 `@my-agent-team/message`，不复制消息模型。
3. Product DB、Runtime Plugin、Coding Session Tree、Provider credential 都不能进入公共协议。
4. `Agent Run` 是产品执行身份；`BackendRunSegment` 是一次 Adapter continuation；`Agent Loop` 不出现在协议中。
5. `suspended` 是 segment outcome，不是 Agent Run terminal status。

## 目标文件

```text
packages/agent-backend/
  package.json
  tsconfig.json
  tsconfig.test.json
  src/model.ts
  src/history.ts
  src/run.ts
  src/event.ts
  src/backend.ts
  src/index.ts
  src/contracts.test.ts
```

## 公共类型

- Model：`BackendModelRef`、`BackendModel`、`BackendModelCatalog`。
- History/config：`ProjectedHistoryItem`、`AgentRunSnapshot`、`WorkspaceBinding`、`ProductToolDescriptor`。
- Execution：`BackendStartInput`、`BackendRunInput`、`BackendSessionHandle`、`BackendSessionRun`、`BackendRunSegment`、`BackendRunOutcome`。
- Continuation：`PendingAction`、`PendingActionResponse`。
- Observation：`BackendEvent`、`Usage`。
- API：`AgentBackendCapabilities`、`AgentBackend`。

## 实现步骤

1. 创建 workspace package；只依赖 `@my-agent-team/message`，必要时使用 Zod 做边界 validation。
2. 固定 `runId`、`branchId`、`productEntryId`、`backendSessionId`、`actionId`，禁止通用 `ExecutionId`。
3. `AgentRunSnapshot` 固定 model、systemPrompt、productTools、configRevision；`start()` 和 `send()` 都必须接收。
4. 定义 terminal outcome：completed/failed/aborted/timeout；定义 nonterminal suspended。
5. Capability 仅包含 persistentSession、nativeResume、nativeSteer、thinkingStream、productTools、pendingActionResponse；不含 nativeFork。
6. 核心事件保持小集合；扩展事件只能使用 `backend.<kind>.*`。
7. 删除或停止导出任何与新合同冲突的旧公共协议，不建立 shim。

## 验收

- package 独立 build/typecheck/test。
- fake Backend 能实现完整 `AgentBackend`。
- consumer 只依赖该 package 消费 events/outcome。
- `send()` 缺少 `AgentRunSnapshot` 时编译失败。
- `ProjectedHistoryItem` 缺少 `productEntryId` 时编译失败。
- 公共包不依赖 backend、agent、ai、Elysia、Drizzle、bun:sqlite。
- 公共 API 中没有 `ProductTurn`、`RuntimeBinding`、`runtimeSessionId`、`AgentSessionPool`、`AgentLoop`、`SpanResult`。

## 完成条件

Phase 0 完成后，后续所有模块以此 package 为唯一执行协议。任何协议变化先修改架构设计，不在 Adapter 内私自扩展核心类型。
