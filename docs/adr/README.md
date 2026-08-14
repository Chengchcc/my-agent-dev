# ADR 索引

决策记录的**唯一目录**。架构级规则文档(design-philosophy / e2e-contract-rules / db-typesafe-rules)与协议实测记录(gate0)仍在 `docs/architecture/`,见文末链接。

**状态图例**:Accepted=现行有效;Implemented=已实施;Superseded=被后续迭代取代(仅历史);Deferred=维持不做;Obsolete=对象已移除;被取代/目标达成=以不同形态落地。

| # | 标题 | 状态 |
|---|---|---|
| 0001 | loop-prune-is-post-processing | Accepted |
| 0002 | config-generation-is-builtin-skill | Accepted |
| 0003 | state-md-single-writer | Accepted |
| 0004 | discovery-is-agent-session | **Obsolete**(discovery 已从 loopStep 移除) |
| 0005 | mcp-deferred-for-loop | Deferred 维持(MCP 已落地,loop 未接入) |
| 0006 | loop-lock-deferred | Deferred(曾落地后回退) |
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
| 0023 | project-worktree-workspace(多对多 worktree 桥接) | Proposed |
> 编号历史:0002/0003 曾各有两个文件(早期 loop 类与近期 backend-kinds 类重号);2026-08-13 统一后,backend-kinds 类顺延为 0019/0020。

## 架构级决策文档(非 ADR,但同属决策面)

- `docs/architecture/design-philosophy.md` — 8 条架构原则
- `docs/architecture/e2e-contract-rules.md` — 跨进程类型契约规则
- `docs/architecture/db-typesafe-rules.md` — DB 类型链规则
- `docs/architecture/execution/backend-kinds-gate0.md` — 多 backend 协议实测记录(决策见 §7)
