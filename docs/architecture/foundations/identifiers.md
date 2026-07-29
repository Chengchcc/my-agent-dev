---
id: foundations.identifiers
title: 标识符体系
status: current
owners: architecture
last_verified_against_code: 2026-07-28
summary: "系统里的 id 不是一堆并列的字符串，而是两类截然不同的东西：实体主键（conversationId / agentId / cronJobId / memberId，各自独立、ulid 生成、互不派生）和运行上下文 id（sessionId / spanId / attemptSeq，沿一条派生链层层收束）。本页用第一性原理说明「哪个 agent、在哪个上下文里、的那条持久记忆线」就是一个 session--它对齐分布式追踪里的一条 trace，本体在最底层持久化端口里只有一个 key（已正名为 sessionId）。span 是 session 上的一次 prompt loop（对齐追踪里的 root span），attempt 是 span 内的重试序号、不配独立 id。本页同时立下「每个 id 归属哪一层」的准则：持久化端口认 sessionId 并按 spanId 切执行事实流，backend 拥有 span/attempt 调度。"
depends_on:
  - design-philosophy
  - foundations.facts-and-projections
used_by:
  - agent.agent
  - runtime.framework
  - backend.overview
---

# 标识符体系

这个仓里散落着不少 id：`conversationId`、`agentId`、`memberId`、`cronJobId`、`threadId`、`runId`、`attemptId`。新接手的人第一反应是「怎么这么多」。但它们不是平级的——把它们摆对位置后，真正的领域 id 只有少数几个，其余要么是实体主键，要么是同一条派生链上的不同粒度。

本页要回答三个问题：

1. 这些 id 各自是什么，谁派生谁？
2. 「那条持久记忆线」的本体到底是谁，为什么它该叫 `sessionId` 而不是 `threadId`？
3. 每个 id 归属哪一层（backend / agent / 持久化端口），谁有权发明它？

> 这页描述的是收敛后的模型，已随 P8-P11 落地。代码现状以 HEAD `d69d3e16` 为准。

## 对齐分布式追踪的词汇

运行上下文这条链不是我们独创的，它和分布式追踪（OpenTelemetry / Dapper 这一脉）的模型一一对应。标准追踪里只有两个层级：**trace**（一次端到端的完整调用链，由一棵 span 树组成）和 **span**（链路里的一个工作单元，有 id、起止时间、父子关系，根节点叫 root span）。「run」不是追踪词汇——它是工作流领域的词；LLM 可观测社区（LangSmith、Langfuse 等）虽常用 run，但本质把它当 span 的别名。

我们采用追踪词汇，让本体单一、不再出现「run/span 两个名字指同一个东西」：

| 我们的概念 | 追踪角色 | 标识符 |
|---|---|---|
| session（持久记忆线） | 一条 trace | `sessionId`（即 trace 线的 key） |
| span（一次 prompt loop） | root span | `spanId` |
| step（llm_call / tool_call） | child span | `childSpanId`，parent = `spanId` |

下文一律用 span 指代「一次 prompt loop」，不再使用 run 这个领域词。代码侧的符号（`RunSupervisor` / `run-executor` / `run_origin` 等）随后由工程改名收敛，文档先行立词。

## 两类 id，先分清

所有 id 先劈成两类，混在一起讲是一切困惑的根源。

### 第一类：实体主键（独立、不派生）

它们标识一个**独立存在的领域实体**，各自用 `ulid()` 或 `randomUUID()` 生成，彼此之间没有派生关系：

| id | 实体 | 生成 |
|----|------|------|
| `conversationId` | 一场会话 | 独立 |
| `agentId` | 一个 Agent | 独立 |
| `memberId` | 会话里的一个成员（人或 agent） | 独立 |
| `cronJobId` | 一个定时任务 | 独立 |

这类 id 的特点：**它回答「这是哪一个东西」，不回答「它在哪个上下文里运行」**。删掉运行时，它们照样存在。

### 第二类：运行上下文 id（派生链）

它们标识「一次 Agent 运行的某个粒度」，沿一条链层层收束：

```text
sessionId  ← 哪个 agent、在哪个上下文里、的那条持久记忆线（= 一条 trace）
   │  （派生自实体主键，见下）
   └── spanId  ← 这条线上的一次 prompt loop（root span）
          │
          ├── attemptSeq    ← 这次 span 内的第几次重试
          └── childSpanId   ← span 内的 llm_call / tool_call（child span）
```

这些不是各自独立的实体，而是**同一次运行的不同缩放级别**：session 是整条记忆线（trace），span 是其中一轮对话循环（root span），attempt 是一轮里的一次执行尝试，child span 是一轮里的每步模型/工具调用。

## 本体是 session，它的 key 在最底层早就统一了

用户的直觉是对的：「哪个 agent、在哪个上下文里、的那条持久记忆线」应该就是一个 **session**。而代码最底层正好印证了这一点——

持久化端口（`MessageStore` / `EventLog` / `InterruptStore`）的方法入参都以这一个 id 为主键（`packages/agent/src/persistence/message-store.ts`、`event-log.ts`、`interrupt-store.ts`）。sqlite 实现的三张表（`checkpoint_messages` / `checkpoint_interrupts` / `checkpoint_events`）都以它分区，`MessageStore.save` 是按它做的 upsert（`packages/agent/src/persistence/sqlite-persistence.ts` 的 `onConflictDoUpdate`）。

也就是说：

> **最底层存储里，「那条持久记忆线」只有一个分区 key。它持久、唯一、就是 session 本身。**

这个 key 曾叫 `threadId`。但 `thread`（线程）是个机制词--它来自「消息线程」的实现联想，而非领域语言。领域里这条线就是一个 **session**：一个 agent 在一个上下文里的持久对话状态，也就是追踪意义上的一条 trace。正名已落地：

```text
threadId  ->  sessionId
```

这不是改个名字的洁癖。按[架构设计哲学](../design-philosophy.md)「名字就是架构」，`threadId` 这个名字暗示它是消息层的实现细节，于是上面每一层都不把它当本体，各自又发明了自己的 key（见下节）。改名 `sessionId` 把本体的身份立起来，让上层有一个清晰的东西可依附。

### sessionId 怎么派生

session 不是凭空生成的 id，而是由「哪个上下文 + 哪个 agent/成员」拼出来的稳定字符串。仓里有两种触发源，两条派生公式：

| 触发源 | sessionId 公式 | 代码 |
|--------|------------------------------|------|
| 会话 | `${conversationId}:${memberId}` | `conversation/service.ts:24` |
| Cron | `${cronJobId}:owner` | `cron/scheduler.ts:36` |

读法：**sessionId = 上下文实体主键 : 这条线归谁**。同一个 conversation 里两个成员各有自己的 session（记忆线不串）。这正是「哪个 agent、在哪个上下文里」——两个维度拼成一条线的身份。

## span 是 session 上的一次 prompt loop

`span` 不是多余概念，它有清晰的领域含义：**session 上的一次 `prompt()` 调用——从用户（或触发源）给一个输入，到 agent loop 跑完为止**。一条 session 会经历多次 span：用户问一句是一个 span，下次再问是下一个 span，cron 到点触发又是一个 span。这正对应追踪里「一条 trace 由多个 span 组成」。

`spanId` 由 backend 在每次发起运行时 `crypto.randomUUID()` 生成（`conversation/service.ts:144`、`conv-svc-factory.ts:100`/`:157`），随后传进执行链。它的作用是给执行事实流和 assistant 消息切片：`assistantMessageId(spanId, ordinal)` 产出 `span:${spanId}:assistant:${ordinal}`（`packages/message/src/helpers.ts`），`EventLog` 的事件流按 `spanId` 归集--同一条 session 上的每个 span 各占一段。

所以 span 和 session 的分工是：

```text
session  ->  这条线「当前是什么状态」（MessageStore/InterruptStore 消息/中断快照，被每个 span upsert 覆盖）
span     ->  这条线「按一次次输入切分的执行事实流」（checkpoint_events，每个 span 一段，按 spanId 切）
```

注意两者都落在 **持久化端口**：当前状态和历史事实流是同一条 session 的两个面，按同一个 sessionId 同库同源，再按 spanId 切片回看「第 3 个 span 开始前长什么样」。这一点是 runner daemon 删除后的重要回归--见下节。

### 执行事实流回归持久化端口

历史上持久化的「执行事实流 / 审计」职责曾被剥离到一张独立的 `event_log` 表（runner daemon 时代，跨进程上报需要一个独立容身处）。daemon 删除后该表失去写入方、成了死表，职责悬空。

收敛已落地：执行事实流回到持久化端口。`checkpoint_messages` / `checkpoint_interrupts` 服务恢复，`checkpoint_events`（按 `sessionId` + `spanId` 切）服务观测、审计与回放。`EventLog` 的 `appendEvent` / `readEvents` 是持久化端口的一等能力。`event_log` 表已删除。

要回看「第 3 个 span 开始前长什么样」，靠 `EventLog.readEvents` 按 spanId 切片即可--不需要另一个表、另一个库。两者的边界见[事实与投影](facts-and-projections.md)。

## attempt 是 span 内的重试序号，不配独立 id

`attempt` 的领域含义是：**同一个 span 因为崩溃/超时/重启，被重新执行的某一次尝试**。同一个 span 的多次 attempt 共享同一个输入和意图，只是物理上跑了不止一遍。

关键事实（HEAD 核实）：

- 全仓**只有一个** `INSERT INTO attempt` 站点（`supervisor.ts:186`），值恒为 `att-${runId}`。今天 attempt 与 span 是 **1:1**，`attemptId` 完全由 spanId 派生，不携带任何额外信息。
- `attempt` 表的索引 `idx_attempt_run` 建在 `(runId, startedAt)` 上；reattach 取「最新活着的 attempt」用的是 `WHERE run_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`（`runtime-ops/service.ts`）。这正是「span 下的有序子项」语义。
- `control_plane_event.attemptSeq` 是 **nullable integer，没有 `.references()`**（`schema.ts`，S4 改名原 `run_ops_event`）——它不是外键，只是审计标注列。没有任何强引用绑死 attempt 的字符串形态。

结论：attempt 的真正身份是 `(spanId, seq)` 复合键，`seq` 在 span 内单调递增。它本来就是个序号，不值得拥有一个全局 id。`att-${runId}` 应退化成 `seq=1`。这样消掉一个冗余 id，符合[设计哲学](../design-philosophy.md)「概念要少」。

> 追踪纯粹派会把重试建模成「新 span + span link 关联原 span」。我们不引入 link 机制，用 `attemptSeq` 这个序号属性表达重试，更轻；前提见下。

> 唯一的前置确认：attempt 不作为对外稳定 opaque handle 被第三方引用。HEAD 核实——它只在 ops 内部用于「取最新活着的那次」和审计展示，无外部 API 把它当长期句柄。所以 seq 安全。

## resume 不需要新 id

`resume`（恢复）不是一次新 span，而是**同一个 span 被中断后从 checkpointer 续上继续跑**。它对应 `agent.continue()` 语义：同一条 session、同一个 spanId、只是新开一次 attempt。所以 resume 既不需要新 sessionId 也不需要新 spanId——它只是让 `attemptSeq` +1。把 resume 误当成新 span 来发 id，正是概念膨胀的典型来源。

## 每个 id 归属哪一层

这是用户最在意的一点：id 的层归属现已清晰。归属准则：

```mermaid
flowchart TB
  subgraph backend["backend 层"]
    SPAN["spanId 生成<br/>attemptSeq 调度<br/>span/attempt 生命周期"]
  end
  subgraph agent["agent 层"]
    SESS["Agent<br/>持有 sessionId 身份<br/>跨 span 活着"]
  end
  subgraph cp["持久化端口层"]
    KEY["认 sessionId<br/>存 session 状态<br/>按 spanId 切事实流"]
  end
  SPAN -->|prompt(input, spanId)| SESS
  SESS -->|load/save(sessionId)<br/>appendEvent(sessionId, spanId, …)| KEY
```

- **持久化端口层**：以 `sessionId` 分区，存「这条 session 当前是什么状态」，并按 `spanId` 切出执行事实流。它不调度 span、不知道 attempt 调度。
- **agent 层**：`Agent` 拥有 session 身份，**跨 span 活着**（见下文决定），按 `sessionId` 注册。每次 span 由 backend 通过 `prompt(input, { spanId })` 把当次 spanId 显式传进来。
- **backend 层**：拥有 `spanId` 的生成与 `attemptSeq` 的调度、span/attempt 的生命周期（supervisor）。它不发明 session 的身份，只在已有 session 上发起一次次 span。

一句话准则：**sessionId 属于最底层（存储事实），spanId/attemptSeq 属于最上层（调度事实），agent 层居中、持有 session 对象但接收 spanId**。谁发明 id 的标准是「谁拥有这个粒度的事实」，不是「谁用起来方便」--后者正是[设计哲学](../design-philosophy.md)警告的「模块边界复制成领域边界」。

## 决定：Agent 跨 span 持久

既然本体是 session、持久化端口只认 sessionId，那么 agent 层的 `Agent` 就和这个本体对齐--**一个 sessionId 对应一个长期活着的 Agent，跨多个 span 复用**，而不是每个 span `new` 一个再 `dispose`。

这带来四点约束（均已落地）：

1. **registry 按 sessionId 做 key**，不再按 spanId。
2. **span 结束只标记 span 终态，不销毁 session**。
3. **session 回收策略**--这是跨 span 持久引入的成本。候选：idle timeout 回收、进程退出回收、显式 close（会话关闭 / agent 下线）。
4. **spanId 流进 agent 层**。`prompt()` 把当次 spanId 透传到 span-loop，`assistantMessageId(spanId, ordinal)` 和 `appendEvent(sessionId, spanId, …)` 在一条 session 服务多个 span 时不串号。

## 收敛已完成

P8-P11 已逐项消除此前的概念债。记录收敛前状态与落地结果：

- **Agent 跨 span 持久**：`session-registry` 改按 `sessionId` 做 key，`executeAgentRun` 不再每次 `new` + `dispose`。✅
- **spanId 流进 agent 层**：`AgentConfig` 收 `sessionId`，span-loop 接收 `spanId`。✅
- **threadId 正名**：全仓已改名 `sessionId`，本体身份已立起来。✅
- **run 词与 span 词对齐**：代码符号 `runId` / `RunSupervisor` / `run_origin` 保留（工作流领域词），但执行内核用 `spanLoop`。追踪词汇已对齐。✅
- **执行事实流回归持久化端口**：`event_log` 表已删除，`EventLog` 的 `appendEvent`/`readEvents` 按 spanId 切片，是持久化端口一等能力。✅
- **attempt 仍有独立 id**：`att-${runId}` 形态保留（ops 内部用），`attemptSeq` 作为审计标注列。概念债已收窄。✅

这些收敛让「一条 session」这件事不再散在三层、三个名字里。

## 关联页面

- [架构设计哲学](../design-philosophy.md) -- 「名字就是架构」「概念要少」「模块边界 ≠ 领域边界」的总纲
- [事实与投影](facts-and-projections.md) -- 持久化端口存状态、按 spanId 存执行事实流的边界
- [依赖注入](dependency-injection.md) -- executeAgentRun 的 DI 病灶，与本页的 id 病灶同源
- [Agent](../harness/harness.md) -- Agent 的构造与生命周期
- [Agent 运行循环](../runtime/framework.md) -- spanId 流入 span-loop 的发生处
