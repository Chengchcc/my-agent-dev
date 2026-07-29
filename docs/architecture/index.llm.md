# LLM 入口索引

本目录主 Wiki 描述目标架构。核心目标是让 Product Backend 与 Agent 执行引擎解耦，使 Claude Code、Codex、OpenCode 和自研 Agent Engine 都能通过 Agent Backend 接入。

页面可独立阅读；`status: design` 表示设计已固定但实现尚未完全迁移。

## 整体架构

1. `system-overview.md`
2. `foundations/facts-and-projections.md`
3. `backend/overview.md`

## 数据归属与历史

1. `foundations/facts-and-projections.md`
2. `conversation/history.md`
3. `agents/context.md`
4. `backend/data-model.md`

关键结论：

```text
Conversation History = 共享会话事实
Agent Context = 单 Agent Member 的 context 事实
Execution session = 可丢弃执行缓存
```

Agent Run = Product Backend 持久执行身份，可包含多个 run segments
Agent Loop = Coding Agent 内部执行机制

## Agent Backend / Claude / Codex / OpenCode

1. `execution/agent-backend.md`
2. `agents/context.md`
3. `backend/overview.md`

Product Backend 只依赖 AgentBackend 协议，不依赖 Runtime 内部 transcript、tool loop、retry、compaction 或 sub-agent。

## 消息重复、丢失与终态

1. `runs/output-and-live-updates.md`
2. `conversation/history.md`
3. `agents/context.md`
4. `flows/e2e-web-message.md`

关键结论：Streaming 是 transient projection；Terminal BackendRunOutcome 后才原子提交 Ledger Message 与 Tree 引用。

## Context Branch / Fork / Rollback

1. `agents/context.md`
2. `execution/agent-backend.md`
3. `backend/data-model.md`

Context Branch 内固定 Agent Backend。切换 Backend 必须 fork；fork 默认继承，也可显式选择新 Backend。

## 工具与 MCP

1. `execution/agent-backend.md`
2. `agents/context.md`

Runtime 原生工具由 Runtime 自己执行。Conversation、Task、Memory、Artifact、审批、History 等 Product Tool 由 Product Backend 执行，MCP 优先、Adapter fallback。

## Web

1. `flows/e2e-web-message.md`
2. `surfaces/web.md`
3. `runs/output-and-live-updates.md`

## Lark

1. `surfaces/lark.md`
2. `conversation/history.md`
3. `runs/output-and-live-updates.md`

## 自研 Runtime

1. `runtime/coding-agent.md`
2. `runtime/coding-agent-session.md`
3. `runtime/coding-agent-prompt.md`
4. `runtime/coding-agent-models.md`

Coding Agent 是无 UI、独立进程的 Coding Runtime，通过 CodingAgentBackend 接入 Product Backend。其 Coding Session Tree 是可重建执行缓存，不是 Agent Context。

## 结构化索引

完整页面图谱见 `concepts.json`。
