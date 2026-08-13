# LLM 入口索引

本目录主 Wiki 描述当前架构:Product Backend 拥有产品事实,四 Agent Backend(coding-agent/claude/pi/omp)为每个 Agent Run spawn 一次性子进程执行;Agent 配置与记忆住在工作区文件里。页面可独立阅读;`status: deprecated` 表示 tombstone(历史概念,新设计不要引用);带 ⚠ banner 的页面部分过时。

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
coding-agent 子进程 = 单次 Run 的可丢弃执行缓存
```

Agent Run = Product Backend 持久执行身份（唯一执行身份，无 span/attempt/session）
Agent Loop = Coding Agent 子进程内部执行机制

## 执行链（Agent Backend / Coding Agent）

1. `execution/agent-backend.md`
2. `agents/context.md`
3. `backend/overview.md`
4. `runtime/coding-agent.md`

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

Coding Agent 是无 UI 的一次性 CLI（print/json/rpc），由 Adapter 按 Run spawn。其 in-memory SessionStore 是单次 Run 的执行缓存，不是 Agent Context。

## Tombstones（历史概念）

- `runtime/framework.md`、`runtime/context-manager.md`、`runtime/plugin.md`、`runtime/memory.md`、`harness/harness.md`、`backend/event-log.md`、`plugins/task-guard.md`、`plugins/fs-memory.md` —— 旧 daemon/session/plugin 架构的 tombstone,新设计不要引用。
## 结构化索引

完整页面图谱见 `concepts.json`。
