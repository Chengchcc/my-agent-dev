# Phase 4：完成 Agent Run Execution 与 Product Tools

## 目标

在 Product Backend 内完成 Agent Run 的创建、排队、执行、恢复和 terminal commit，将 Phase 1 的 Agent Context/Run facts 与 Phase 3 的 Oma Backend 连接起来。交付无 UI 的端到端 Agent Run，但不迁移 Conversation/Cron/Loop 业务入口。

```text
现有 Conversation + Agent Member + Context Branch
→ enqueue/acquire Agent Run
→ dispatch 到 OmaBackend（唯一 Backend，无 registry）
→ Oma 通过 MCP 调用 Product History Tool
→ BackendRunOutcome
→ backend.db 原子提交：
   Conversation History Message
   Agent Context ledger_message ref
   Context Branch revision/leaf
   BackendSessionBinding sync
   Agent Run terminal status
```

最终调用者只需要：创建 Agent Run → dispatch → 订阅 Live Updates → 查询 Run 结果。不需要理解 Coding Session、Worker、Adapter、MCP 或 Agent Loop。

## 不兼容策略

- Phase 4 新增模块（agent-run/execution、product-tools）不调用旧 `@chengchenccc/agent`；未切流的 Product caller 留到 Phase 5。
- 不使用 member.sessionId、checkpointer.db、ConversationLock 或 activeSessions。
- 不提供旧 session 到 backendSessionId 的映射。
- 不把 span/attempt 作为 Agent Run terminal authority。
- 不创建 fake/in-process Backend；Product Backend 不导入 Provider SDK 或 Oma Runtime。
- 不创建 AgentBackendRegistry、AgentRunScopeService、BackendSessionCache、AgentRunQueries、AgentRunPool、scopeKey 表或通用 Backend 管理框架。

## 约束

1. Run scope：conversationId + agentMemberId + branchId（来自现有事实，非新领域对象）。
2. 同 branch 单 active Agent Run。
3. 输入在 Backend accept 前不能标记 delivered；accept 前 crash 可重投，Backend 按 run/input idempotency 去重。
4. BackendSessionBinding 是唯一持久 session metadata；resume 仅在状态完全匹配时，否则从 Agent Context rebuild。model/systemPrompt/productTools/configRevision 变化不强制 rebuild。
5. terminal commit 使用同一 backend.db transaction。
6. commit_failed 期间 branch 不释放；retryTerminalCommit 只重放 stored outcome，绝不重新调用 Backend。
7. Product Tool 身份、授权、幂等、审计由 Product Backend 负责（service 内部流程，非独立 service）。
8. Phase 4 只实现 History Product Tools；Task/Artifact/Memory/Approval 无 canonical service 不实现。
9. Live Updates 只进入进程内瞬时通道，不写 Conversation History / Agent Context；subscriber 断开不取消 Run。

## 目标文件

```text
apps/backend/src/features/agent-run/
  execution.ts
  execution.test.ts
  adapter-sqlite.ts       # + commitCompletedRun / failCommit / listDeliveringInputs / listCommitFailedRuns / setRunProductTools
  ports.ts                # + 上述窄方法
  index.ts

apps/backend/src/features/product-tools/
  service.ts
  service.test.ts
  adapter-sqlite.ts       # product_tool_call durable idempotency
  adapter-sqlite.test.ts
  mcp.ts                  # SSE transport + service-token 认证
  mcp.test.ts
  index.ts

apps/backend/tests/integration/
  agent-run-oma.test.ts
```

可修改：`apps/backend/src/config.ts`、`packages/config/src/env.ts`、`apps/backend/package.json`、`apps/backend/src/bootstrap/features.ts`、`apps/backend/src/infra/db/schema.ts`、`apps/backend/drizzle/backend/0013_*.sql`、`apps/oh-my-agent/src/worker-runtime.ts`（MCP Bearer token）。

## 实现步骤

1. Backend-only 配置：OMA_URL / OMA_SERVICE_TOKEN / PRODUCT_TOOLS_MCP_URL / PRODUCT_TOOLS_SERVICE_TOKEN。Provider credential 仍只属于 Oma 服务。
2. 直接构造 OmaClient / OmaBackend / OmaModelCatalog 注入 Execution Service；只支持 backendKind=oma。
3. Agent Run snapshot：runId / modelRef / systemPrompt（Phase 4 无 canonical prompt 系统，允许最小 systemPrompt 并记录 ceiling）/ productTools（buildHistoryTools(entrypoint)）/ configRevision。Workspace 来自 Agent 的 workspacePath + 权限映射。
4. AgentRunExecutionService：dispatch / recover / retryTerminalCommit / stop / subscribe。dispatch 内部：load Run → claim input（delivering 恢复优先）→ 投影 Agent Context → 组装 input → start/resume/send（acceptance 后 markInputAccepted）→ 瞬时转发 events → await outcome → settle（completed 原子 commit；其他 terminal 不写 assistant Message + binding stale）。
5. terminal commit：commitCompletedRun 单事务写 ledger + context ref + branch + binding + run；runId 为幂等身份；失败 → failCommit（commit_failed + stored outcome + branch 占用 + binding stale）。
6. Product Tools：单一 ProductToolsService（授权/幂等是内部私有流程）；History 工具 history_recent/search/around/retain；scope 从 run 派生；read-only 不写 Context/call 表；retain 语义 mutation 带 (runId, callId) durable 幂等。
7. Product Tools MCP：官方 SDK + SSE transport；token 认证；错误归一化为 isError。Oma Worker 的 sse: transport 携带 OMA_PRODUCT_TOOL_TOKEN Bearer。
8. Composition：bootstrap 组装 execution + product tools + MCP server；start 调 recover()；dispose 关闭 MCP；InstalledFeatures 暴露 agentRunService / agentRunExecution / productTools。

## 验收

- 每 Session mutation 串行；输入 accept 前 crash 可重投且只产生一次语义输入。
- Backend restart 后 delivering 队列不丢、不乱序；terminal 后最旧 follow-up 保持 pending 等待下个 Run。
- resume/rebuild 纯函数：binding active + kind 匹配 + session id + synced entry + revision gap ≤ 1 → resume；否则 stale + rebuild。
- 同一 Session 并发 normal/follow-up 至多一个被接受。
- commit 成功时每个 Product 事实恰好写一次；transaction 失败 → commit_failed 无部分可见；并发 retry 只 commit 一次且不重新执行 Backend。
- failed/aborted/timeout 不写 assistant History Message。
- Product Tool：forged/terminal/未声明 tool 拒绝；History 查询只在本 Conversation；read-only 不写 Context；retain 可见消息且幂等；同 callId 不同输入 conflict。
- MCP：token 缺失/错误 401；malformed input → isError；真实 client 连接可 list/call。
- 真实链路：Product Backend → OmaBackend HTTP/SSE → 真实 daemon → 真实 Worker → Product Tools MCP → BackendRunOutcome → backend.db 原子 commit。
- Phase 4 新增模块不 import `@chengchenccc/agent`；Conversation/Cron/Loop/Skill Pack 不调用 Phase 4 服务；全 `apps/backend` 零旧引用属于 Phase 5 clean gate。

## 完成条件

Agent Run execution 可用。所有后续业务入口只需要创建 Agent Run，不理解 execution session、Adapter、Worker 或 Agent Loop。
