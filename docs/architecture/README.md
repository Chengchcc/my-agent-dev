---
id: architecture.index
title: 架构 Wiki 首页
status: current
owners: architecture
last_verified_against_code: 2026-07-28
summary: "这是给人看的架构 Wiki 入口。它不是按里程碑流水账排的，而是按「你想干什么」组织阅读路线。先在这里选好路线，再去读具体实现页。"
depends_on:
used_by:
---

# 架构 Wiki 首页

这是给人看的架构 Wiki 入口，按「你想干什么」组织阅读路线。先选路线，再读具体实现。

读完相关页面，你应该不用翻源码就能讲清楚系统怎么运转--消息怎么从输入框到 ledger、一次运行怎么被监督和恢复、一份产出怎么在 Lark 端做到不重不丢。每页正文是中文叙述加配图和伪代码；页首 frontmatter（YAML 元数据：`summary` / `depends_on` / `used_by`）和独立的 `index.llm.md`、`concepts.json` 供 LLM 消费。

## 推荐阅读路线

### 想搞懂整个系统

1. [系统总览](./system-overview.md)
2. [事实与投影](./foundations/facts-and-projections.md)
3. [Web 消息端到端](./flows/e2e-web-message.md)
4. [会话投影](./backend/conversation-projection.md)
5. [排障手册](./operations/troubleshooting.md)

### 在后端运行时上干活

1. [后端总览](./backend/overview.md)
2. [Agent](./harness/harness.md)
3. [EventLog（已废止）](./backend/event-log.md)
4. [会话投影](./backend/conversation-projection.md)
5. [数据模型](./backend/data-model.md)

### 在 Agent 运行时上干活

1. [Agent](./harness/harness.md)
2. [Agent 运行循环](./runtime/framework.md)
3. [上下文管理器](./runtime/context-manager.md)
4. [Compaction](./runtime/compaction.md)
5. [Memory](./runtime/memory.md)
6. [运行时插件机制](./runtime/plugin.md)
7. [标识符体系](./foundations/identifiers.md)

### 在 Web 或飞书端干活

1. [端总览](./surfaces/overview.md)
2. [Web 端](./surfaces/web.md)
3. [飞书适配器](./surfaces/lark-adapter.md)
4. [对话账本](./conversation/ledger.md)
5. [飞书消息端到端](./flows/e2e-lark-message.md)

### 想搞懂 Loop 与自动化编排

> `foundations/loop.md`、`backend/loop-runner.md`、`foundations/loop-pattern.md` 均为 `status: design`（已锁定设计，尚未进代码）。

1. [Loop](./foundations/loop.md) - 按调度自动发现工作、用 Generator/Evaluator 分离的流水线推进
2. [LoopRunner](./backend/loop-runner.md) - Loop 的编排引擎：discovery -> generator -> evaluator -> human gate
3. [Loop Pattern](./foundations/loop-pattern.md) - 7 种预制配置模板 + L1/L2/L3 信任层级 + Loop Ready Score
4. [Loop Engineering](./foundations/loop-engineering.md)（`status: design`）
5. [Loop 验证端到端](./flows/e2e-loop-verification.md)（`status: design`）

## 给 LLM 的入口

- [LLM 索引](./index.llm.md)：按问题类型给出「先读这几页」的路由。
- [概念图谱](./concepts.json)：机器可读的页面依赖图。
- [跨页地图](./map.md)：给人看的依赖关系图。

## 每页的固定骨架

核心页大致是这个顺序，方便你在不同页之间快速定位：

1. 页首一句话导读（H1 正下方那段）。
2. 这页解决什么问题。
3. 现在代码怎么做的（真实符号名、控制流、配图）。
4. 输入与输出。
5. 关键数据结构。
6. 运行时序。
7. 不变量。
8. 失败模式。
9. 例子。
10. 当前缺口。
11. 关联页面。

## 一条规则：先写现状

正文描述的是「当前代码就是这么跑的」。还没落地的设想统一放进 [未来工作](./roadmap/future-work.md) 或某页的「当前缺口」小节，不要混进现状描述里--否则读者会把愿景当成已实现。
