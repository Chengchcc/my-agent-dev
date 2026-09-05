# ADR 索引

决策记录的**唯一目录**。架构级规则文档(design-philosophy / e2e-contract-rules / db-typesafe-rules)与协议实测记录(gate0)仍在 `docs/architecture/`,见文末链接。

**状态图例**:Accepted=现行有效;Implemented=已实施;Superseded=被后续迭代取代(仅历史);Deferred=维持不做;Obsolete=对象已移除;被取代/目标达成=以不同形态落地。

| # | 标题 | 状态 |
|---|---|---|
| 0001 | loop-prune-is-post-processing | **Obsolete**（Loop 已删，2026-08-28） |
| 0002 | config-generation-is-builtin-skill | **Obsolete**（Loop 配置生成随 Loop 删除） |
| 0003 | state-md-single-writer | **Obsolete**（STATE.md 状态机随 Loop 删除） |
| 0004 | discovery-is-agent-session | **Superseded**(发现环节以 triage workflow 回归,ADR 0025) |
| 0005 | mcp-deferred-for-loop | **Obsolete**（Loop 已删；MCP 另见 0012/0022） |
| 0006 | loop-lock-deferred | **Obsolete**（Loop 已删；worktree 互斥另见 0023 workspace-lock） |
| 0007 | span-canonical-run-user-facing | **Superseded**(span 已删,Phase 6) |
| 0008 | collapse-harness-invocation-layer | **Implemented**(Phase 5/6) |
| 0009 | session-layer-owns-identity-features-own-binding | **Superseded**(framework 已删) |
| 0010 | typed-context-keys | **Superseded**(未采纳,引擎已重建) |
| 0011 | web-ia-work-chat-team | **Implemented** |
| 0012 | mcp-client-architecture | Accepted |
| 0013 | memory-plugin | **被取代**(功能吸收进 workspace 文件模型) |
| 0014 | compaction-quality | Accepted |
| 0015 | autonomous-memory | **目标达成**(workspace 文件形态,机制被取代) |
| 0016 | agent-runtime | Implemented |
| 0017 | canonical-message-contract | Accepted |
| 0018 | multi-api-provider-architecture | Accepted |
| 0019 | cli-session-dual-truth(运行态/产品态双轨) | Accepted |
| 0020 | agent-workspace-and-resource-bridge | Accepted |
| 0021 | one-conversation-one-agent-member(session 投影) | Accepted |
| 0022 | mcp-catalog-and-knowledge-packs | Accepted |
| 0023 | project-worktree-workspace(多对多 worktree 桥接) | **Implemented**（features/project + workspace-lock） |
| 0024 | oma-wire-protocol-fixture-contract | Accepted |
| 0025 | loop-workflow-first-execution(Workflow 一等执行) | **Superseded**（2026-08-28 Loop 整体删除，由 Workflow DSL 取代） |
| 0026 | agent-threat-model | Accepted |
| 0027 | ask-question-product-tools-mcp(跨 runtime HITL 提问) | Draft |
> 状态翻转纪律:任何 ADR 状态变更(Obsolete/Superseded/Deferred→Implemented 等)**必须同 PR 更新本索引**,避免索引与正文失配(2026-08-21 修复 0004/0006/0024 时立规)。

## 架构级决策文档(非 ADR,但同属决策面)

- `docs/architecture/design-philosophy.md` — 8 条架构原则
- `docs/architecture/e2e-contract-rules.md` — 跨进程类型契约规则
- `docs/architecture/db-typesafe-rules.md` — DB 类型链规则
- `docs/architecture/execution/backend-kinds-gate0.md` — 多 backend 协议实测记录(决策见 §7)
