# AgentBackend 与 Coding Agent Rewrite Approach

## 目标

把当前 Product Backend 直接创建和控制 `@my-agent-team/agent` session 的架构重写为：

```text
Product Backend
  → Agent Run
      → Agent Backend
          → Claude Code / Codex / OpenCode / Coding Agent

Coding Agent
  → independent process service
      → one Worker per live Coding Session
```

这是破坏性 rewrite，不是兼容迁移：不保留旧 Agent API、旧 runtime session、旧 checkpoint 数据、旧 HTTP contract 或 compatibility shim。Conversation History 等产品事实保留，执行缓存直接废弃。

## 当前代码判断

- Product Backend 在 `conversation-compose.ts`、Cron、Loop 中直接创建 Agent session。
- Conversation 使用进程内 `ConversationLock` 和 `activeSessions`，没有 branch 级持久 ownership。
- Conversation History、member.session_id、span/attempt、checkpoint 分担了 context/run/session 语义。
- `packages/agent` 存在双 Agent 层、双 transcript、错误 retry/compaction/prompt ownership。
- 仓库尚无统一 Agent Backend protocol、独立 Coding Agent service 或持久 Agent Run execution。

详细代码映射和实施约束已进入各 Phase 文档。

## Phase 文档

1. [Phase 0：One Agent Backend Language](./agent-backend-coding-agent-rewrite/phase-0-contracts.md)
2. [Phase 1：Durable Agent Context and Runs](./agent-backend-coding-agent-rewrite/phase-1-agent-context-and-runs.md)
3. [Phase 2：A Complete Coding Agent](./agent-backend-coding-agent-rewrite/phase-2-coding-agent-core.md)
4. [Phase 3：Coding Agent Runs Independently](./agent-backend-coding-agent-rewrite/phase-3-coding-agent-service.md)
5. [Phase 4：Product Backend Executes Agent Runs](./agent-backend-coding-agent-rewrite/phase-4-agent-run-execution.md)
6. [Phase 5：All Product Flows Use Agent Runs](./agent-backend-coding-agent-rewrite/phase-5-product-caller-cutover.md)
7. [Phase 6：Only the New Execution Model Remains](./agent-backend-coding-agent-rewrite/phase-6-remove-old-execution.md)

总索引和依赖图见 [Rewrite Programme](./agent-backend-coding-agent-rewrite/README.md)。

## 依赖关系

```text
Phase 0 One Agent Backend Language
  ├─ Phase 1 Durable Agent Context and Runs
  │    └─ Phase 4 Product Backend Executes Agent Runs
  │         └─ Phase 5 All Product Flows Use Agent Runs
  │              └─ Phase 6 Only the New Execution Model Remains
  │
  └─ Phase 2 A Complete Coding Agent
       └─ Phase 3 Coding Agent Runs Independently
            └─ Phase 4 Product Backend Executes Agent Runs
```

Phase 1 与 Phase 2 可并行。Phase 5 是唯一业务流量切换点。

## 核心原则

- 不做 old/new 双写。
- 不做 deprecated alias 或 compatibility adapter。
- 不迁移旧 execution cache 为新 canonical history。
- Agent Run 决定产品终态；span/attempt 只作 audit。
- Product Context 只向 Coding Session 单向投影。
- terminal commit 使用同一 backend.db transaction。
- 每个 Phase 都有独立目标、约束、实现步骤、验收和完成条件。
