# AgentBackend 与 Oma Rewrite

## 目标

将 Product Backend 与 Agent Runtime 完全解耦，并建立独立 Oma Service。

迁移采用破坏性 clean cutover：**不兼容旧 Agent API、旧 runtime session、旧 checkpoint 数据或旧 HTTP contract**。Conversation History 等产品事实保留；执行缓存直接废弃。

## Phase 文档

| Phase | 文档 | 结果 |
|---|---|---|
| 0 | [One Agent Backend Language](./phase-0-contracts.md) | 所有执行引擎使用同一种 Run 输入、更新和 outcome |
| 1 | [Durable Agent Context and Runs](./phase-1-agent-context-and-runs.md) | Context、Branch、Run 与持久输入成为产品事实 |
| 2 | [A Complete Oma](./phase-2-oma-core.md) | Oma 独立完成模型、工具、session 和 prompt 循环 |
| 3 | [Oma Runs Independently](./phase-3-oma-service.md) | Oma 成为独立进程中的 Agent Backend |
| 4 | [Product Backend Executes Agent Runs](./phase-4-agent-run-execution.md) | Run 执行、原子 commit、Product Tools 全部闭环 |
| 5 | [All Product Flows Use Agent Runs](./phase-5-product-caller-cutover.md) | Conversation/Cron/Loop/Skill Pack 全部切流；续：Run-centric rewrite（HTTP daemon → child-process CLI） |
| 6 | [Only the New Execution Model Remains](./phase-6-remove-old-execution.md) | 删除旧 Agent/checkpoint/API/docs |

## 依赖关系

```text
Phase 0 One Agent Backend Language
  ├─ Phase 1 Durable Agent Context and Runs
  │    └─ Phase 4 Product Backend Executes Agent Runs
  │         └─ Phase 5 All Product Flows Use Agent Runs
  │              └─ Phase 6 Only the New Execution Model Remains
  │
  └─ Phase 2 A Complete Oma
       └─ Phase 3 Oma Runs Independently
            └─ Phase 4 Product Backend Executes Agent Runs
```

Phase 1 和 Phase 2 可以并行。Phase 5 前不得迁移 caller。Phase 6 前不得删除 Product Backend 当前依赖的代码，但不为其编写兼容 shim；programme branch 在中间 Phase 可以暂时不满足全仓编译，Phase 5 恢复全仓一致状态。

## 每个 Phase 的固定结构

每篇文档独立说明：

1. 目标
2. 不兼容策略
3. 约束
4. 目标文件/边界
5. 实现步骤
6. 验收
7. 完成条件

## Programme 规则

- 不做 old/new 双写。
- 不做 deprecated alias 或 compatibility adapter。
- 不把旧 execution cache 迁移为新 canonical history。
- 每个 Phase 按自身验收闭合；不能用“后续补齐”替代当前正确性。
- Phase 5 是唯一业务流量切换点。
- Phase 6 删除全部 legacy path。

## 架构来源

- `docs/architecture/execution/agent-backend.md`
- `docs/architecture/agents/context.md`
- `docs/architecture/backend/data-model.md`
- `docs/architecture/runtime/oma.md`
- `docs/architecture/runtime/oma-session.md`
- `docs/architecture/runtime/oma-prompt.md`
- `docs/architecture/runtime/oma-models.md`
