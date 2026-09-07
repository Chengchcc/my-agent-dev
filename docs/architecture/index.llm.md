# LLM 入口索引

本目录主 Wiki 描述当前架构：Product Backend 拥有产品事实，四 Agent Backend(oma/claude/pi/omp)为每个 Agent Run spawn 一次性子进程执行；Agent 配置与记忆住在工作区文件里。页面可独立阅读；`status: deprecated` 表示 tombstone(历史概念，新设计不要引用)；带 ⚠ banner 的页面部分过时。

## 文档分区(2026-08-21,T6)

| 区 | 路径 | 语义 |
|---|---|---|
| 活区-现状 | `docs/architecture/`(本目录) | 描述代码此刻真实样子，`last_verified_against_code` 可核对 |
| 活区-决策 | `docs/adr/` | 决策档案；ADR 状态翻转必须同 PR 更新 `README.md` 索引 |
| 归档 | `docs/superpowers/` | 历史 spec/plan/retro，**不代表当前架构**；死链/旧术语豁免 |

`audit:docs` 门禁：活区相对链接必须存在(死链 >0 即红)、MANIFEST 收编文件必须存在、活区不得教已删除概念(词表见 `scripts/audit-docs.ts`)。

## 整体架构

1. `system-overview.md`
2. `workflow.md`
3. `foundations/facts-and-projections.md`
4. `backend/overview.md`

## 数据归属与历史

1. `foundations/facts-and-projections.md`
2. `conversation/history.md`
3. `agents/context.md`
4. `backend/data-model.md`

关键结论：

```text
Conversation History = 共享会话事实
Agent Context = 单 Agent Member 的 context 事实
oma 子进程 = 单次 Run 的可丢弃执行缓存
```

Agent Run = Product Backend 持久执行身份（唯一执行身份，无 span/attempt/session）
Agent Loop = Oma 子进程内部执行机制

## 执行链（Agent Backend / Oma）

1. `execution/agent-backend.md`
2. `agents/context.md`
3. `backend/overview.md`
4. `runtime/oma.md`

Product Backend 只依赖 AgentBackend 协议（execute/steer/abort），不依赖子进程内部 transcript、tool loop、retry、compaction 或 sub-agent。

## 消息重复、丢失与终态

1. `runs/output-and-live-updates.md`
2. `conversation/history.md`
3. `agents/context.md`
4. `flows/e2e-web-message.md`

关键结论：Streaming 是 transient projection；Terminal BackendRunOutcome 后才原子提交 Ledger Message 与 Tree 引用（agent_run_id 唯一提交标记）。

## Context Branch / Fork / Rollback

1. `agents/context.md`
2. `execution/agent-backend.md`
3. `backend/data-model.md`

## 工具与 MCP

1. `execution/agent-backend.md`
2. `agents/context.md`

Runtime 原生工具由子进程自己执行。History、审批等 Product Tool 由 Product Backend 执行，Product Tools MCP 是接入方式。

## Workflow / Artifact

1. `workflow.md`
2. `backend/overview.md`

关键结论：Workflow 是编排层身份（execution/node_run/pending_human），不是执行身份：agent 节点创建普通 Agent Run，script 节点走进程沙箱，human 节点挂起于 Web 表单。Artifact 是带类型产物（artifacts:// 引用），节点边界校验存在性。


## Web

1. `flows/e2e-web-message.md`
2. `surfaces/web.md`
3. `runs/output-and-live-updates.md`

## Lark

1. `surfaces/lark.md`
2. `conversation/history.md`
3. `runs/output-and-live-updates.md`

## 自研 Runtime

1. `runtime/oma.md`
2. `plugins/oma-plugins.md`
3. `runtime/compaction.md`

Oma 是 CLI 执行引擎（print/json/rpc 一次性 + TUI 交互终端），由 Adapter 按 Run spawn 其 rpc 模式。其 in-memory SessionStore 是单次 Run 的执行缓存，不是 Agent Context。插件系统与 HITL 见 `plugins/oma-plugins.md`。

## 结构化索引

完整页面图谱见 `concepts.json`。已删除概念（span/attempt/session/daemon/checkpointer/Pet/Recap/多成员/Loop/CronJob）不保留文档页：历史见 `docs/adr/` 与 git 记录。
