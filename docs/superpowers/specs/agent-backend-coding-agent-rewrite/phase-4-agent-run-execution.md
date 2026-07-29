# Phase 4：完成 Agent Run Execution 与 Product Tools

## 目标

在 Product Backend 内完成 Agent Run 的创建、排队、执行、恢复和 terminal commit，将 Phase 1 的 Agent Context/Run facts 与 Phase 3 的 Coding Agent Backend 连接起来。

本 Phase 交付无 UI 的端到端 Agent Run，但不迁移 Conversation/Cron/Loop 业务入口。

## 不兼容策略

- 本 Phase 新增的 Agent Run execution、Product Tools 和 Coding Agent integration 不调用旧 `@my-agent-team/agent`；尚未切流的 Product caller 留到 Phase 5。
- 不使用 member.sessionId、checkpointer.db、ConversationLock 或 activeSessions。
- 不提供旧 session 到 backendSessionId 的映射。
- 不把 span/attempt 作为 Agent Run terminal authority。
- 不通过 in-process closure 注入 Product Tool。

## 约束

1. Run scope：conversationId + agentMemberId + branchId。
2. 同 branch 单 active Agent Run。
3. 输入在 Backend accept 前不能标记 delivered。
4. accept 前 crash 可重投，Backend 按 run/input idempotency 去重。
5. execution session 只在状态完全匹配时 resume，否则从 Agent Context rebuild。
6. terminal commit 使用同一 backend.db transaction。
7. commit_failed 期间 branch 不释放。
8. Product Tool 权限、身份、幂等、审计由 Product Backend 负责。

## 目标文件

```text
apps/backend/src/features/agent-backend/
  registry.ts
  model-catalog.ts
  index.ts

apps/backend/src/features/agent-run/
  execution.ts
  session-cache.ts
  execution.test.ts

apps/backend/src/features/product-tools/
  mcp-server.ts
  service.ts
  authorization.ts
  idempotency.ts
  index.ts

apps/backend/src/features/agent-run-scope/
  service.ts
  service.test.ts
  index.ts
```

修改 bootstrap composition，但不挂载旧 caller。

## 实现步骤

1. 在 Agent Backend 内部 registry 注册 CodingAgentBackend；不实现虚假 Backend。
2. Model catalog 聚合 BackendModel，不泄漏 Provider object。
3. Agent Run Scope 创建/选择 Conversation、Agent Member、默认 Context Branch。
4. Agent Run execution 负责 queue delivery、Backend 调用、terminal commit 和 commit_failed。
5. `session-cache.ts` 只负责 live handle、resume validation、stop/close/detach；它不是领域 service。
6. queue claim → Backend accept → delivered；accept 前 crash 返回 pending。
7. start/send 使用 runId/input idempotency，重投不产生重复 loop。
8. Product Tools service 实现 Conversation、Task、Memory、Artifact、History、approval。
9. MCP request 绑定 run/member/conversation/branch identity；统一 authorization、audit、call idempotency。
10. terminal commit transaction 写 History Message、Context ref、branch revision、session sync、Run terminal。
11. commit_failed 保存 outcome、使 session cache stale、按 runId 幂等重放。
12. Live Updates 只进入 transient channel，不写 Conversation History。

## 验收

- execution session state 完全匹配时 resume；任一字段 mismatch rebuild。
- 输入 accept 前 crash 后可重投，且只产生一次语义输入。
- Backend restart 后队列不丢、不乱序。
- terminal commit fault injection 进入 commit_failed。
- 同 runId commit 重放只写一次 History/Context。
- commit 成功前 branch 仍 locked。
- Product Tools authorization/identity/idempotency/audit tests 通过。
- headless scope 能创建稳定 Conversation/Member/Branch。
- Product Backend 通过 Coding Agent 完成一次无 UI Agent Run。
- Phase 4 新增模块不 import `@my-agent-team/agent`；全 `apps/backend` 零引用属于 Phase 5 clean gate。

## 完成条件

Agent Run execution 可用。所有后续业务入口只需要创建 Agent Run，不理解 execution session、Adapter、Worker 或 Agent Loop。
