---
title: "架构设计哲学"
summary: "Agent 每次设计、评审、修复系统时应遵循的指导思想：统一领域心智，隐藏实现机制，避免把同一语义对象在不同模块中重复发明。"
---

# 架构设计哲学

## 目的

这是一份给 Agent 和工程师使用的**架构判断准则**，不是实现方案，也不是某个模块的重构 spec。每次新增概念、修复问题、写文档、做代码 review、设计 API 前，都先用它检查自己有没有把系统推向不必要的复杂度。

核心目标只有一个：

> 让系统的领域心智保持简单、稳定、可解释。实现机制可以复杂，但不能污染主心智。

## 基本立场

复杂系统不是靠不断增加概念变清晰的。

一个健康的架构应该先问：

```text
这个问题属于哪个已有领域对象？
它是否真的需要一个新概念？
新概念是业务语言，还是实现机制泄漏？
它会不会让下一个 Agent 多学一层心智模型？
```

如果一个新设计让系统出现更多相似但不完全相同的名词，它通常是概念债，不是抽象升级。

## 核心原则

### 先统一语义，再选择机制

不要先从表、日志、队列、stream、projection、checkpoint 出发设计系统。

先问：

```text
这个事实在用户和 Agent 的共同世界里叫什么？
它是否已经能被现有领域对象表达？
```

机制只能服务领域对象，不能替代领域对象。

**反例**：

```text
因为写进 ledger，所以定义 LedgerMessage。
因为写进执行事实流，所以定义 EventMessage。
因为进了 Web，所以定义 UiMessage。
```

**正例**：

```text
Message 是领域对象。
Ledger、执行事实流、Web 只是保存、记录、渲染或投递 Message 的不同场景。
```

### 同一语义对象只能有一个本体

如果多个对象拥有相同的身份、内容、生命周期和状态，它们就不应该被设计成多个领域模型。

判断标准：

```text
它们是否描述同一个"谁在什么时候说了什么"？
它们是否共享同一个完成/失败/等待状态？
它们是否应该在 UI 中 collapse 成同一条东西？
它们是否只是因为所在模块不同而名字不同？
```

如果答案是「是」，那它们应该共用同一个本体。

### 实现机制不能上浮成业务心智

有些机制是必要的：append-only log、event audit、projection、checkpoint、delivery binding、retry queue。

但它们应该待在实现层。

Agent 写文档和代码时，主叙述应该是：

```text
Run 产生 Message。
Conversation 保存 Message。
Surface 渲染 Message。
```

而不是：

```text
RunEvent 进入执行事实流，再由 Projection 写 LedgerEntry，再由 watcher 解释 content JSON。
```

这套机制链路可以存在于底层实现说明，但不应该成为所有功能开发者必须理解的入口。

### 边界要硬，概念要少

系统可以有多个边界，但不能每个边界都重新发明核心对象。

业务边界应该少而稳定：

```text
Conversation
Run
Message
Agent
Memory
Tool
```

机制边界可以多，但必须低调：

```text
Ledger
执行事实流
Projection
Checkpoint
Delivery
Stream
Cache
Index
```

业务边界回答"这是什么"。机制边界回答"它怎么被保存、观察、恢复或投递"。

### 名字就是架构

命名不是表面问题。名字会决定后续 Agent 怎么理解系统。

如果我们把一个实现机制命名成领域对象，后续所有代码都会开始围绕它建模。

**反例**：

```text
CheckpointMessage
LedgerMessage
RunStreamMessage
UiMessageContent
```

这些名字暗示每层都有自己的 message 语义。

**正例**：

```text
Message in checkpoint
Message in conversation storage
Message delivery state
Message render state
```

这些名字说明本体仍然是 Message，其他只是语境。

### Projection is mechanism, not the main thread

Projection 是一种实现方式：从一种事实记录生成另一种读模型。

但如果开发者必须理解 projection 才能理解用户看到的消息，说明机制已经上浮。

主线表达应该尽量简单：

```text
Run emits Message to Conversation.
```

实现可以是：

```text
append event -> project -> append storage -> notify surface
```

但这条链是实现层的细节，不是主心智。

### 控制环需要统一内模

Agent 系统是一个控制系统：它读取状态，采取行动，观察反馈，再继续行动。

控制论里的 Good Regulator Theorem 表达了一个思想：好的调节器必须包含或访问它所调节系统的模型。

对我们的系统来说，这意味着 Agent、Run、Conversation、Surface、Checkpoint 不能各自持有一套漂移的 message 模型。否则控制环会碎：某层认为完成，另一层仍在等待；某层认为同一条消息，另一层发成多条；某层知道需要审批，另一层无法渲染操作。

统一 domain entity 是让控制环稳定，不是洁癖。

### 警惕模块边界变成领域边界

Conway 定律描述了组织沟通结构和系统结构之间的对应关系。在代码中，同样容易出现"模块结构复制成领域结构"的问题。

典型症状是：

```text
backend 有 backend message
framework 有 framework message
web 有 ui message
lark 有 lark message
checkpoint 有 checkpoint message
```

这不一定代表领域真的有这么多 message，可能只是每个模块按自己的便利复制了一份模型。

Agent 每次设计时都要反问：

```text
这是领域边界，还是模块边界？
```

## Agent 执行前检查

每次做架构设计、代码修改、文档更新、review 前，先回答这些问题。

### 概念检查

1. 我是否引入了一个新名词？
2. 这个名词是否能用已有领域对象表达？
3. 它是业务语言，还是实现机制？
4. 它会不会让系统出现两个相似概念？
5. 它是否只因为存储位置、模块位置、surface 位置不同而存在？

如果一个新名词只是因为"它在另一个地方出现"，不要引入它。

### 语义检查

1. 这个对象的身份是什么？
2. 它的生命周期由谁负责？
3. 它的 terminal state 在哪里表达？
4. 它是否用户可见？
5. 它是否需要被模型再次读取？
6. 它是否需要被恢复、审计或投递？

如果这些答案和某个已有对象一致，就不要 fork 新对象。

### 机制检查

1. 我是否把 storage 名称写进了业务 API？
2. 我是否让 surface 消费了内部 event？
3. 我是否让 checkpoint 参与了用户消息语义？
4. 我是否让 projection 成为 feature 开发者必须理解的入口？
5. 我是否把 delivery state 混进了 message content？

如果是，说明机制正在上浮。

## 正反例

### 例子一：消息显示

**反例**：

```text
RunEventMessage -> LedgerMessage -> ConversationMessageRevision -> UiMessage -> LarkMessage
```

问题：同一条消息在每层都被重新定义，状态和身份容易漂移。

**正例**：

```text
Message
  + RunEvent wrapper
  + Conversation storage wrapper
  + UI render state
  + Lark delivery state
```

本体只有一个，外壳可以有多个。

### 例子二：流式输出

**反例**：

```text
每个 seq 都是一条新消息。
Lark 用 seq 做 idempotency key。
Web 用本地 draft 维护另一套 assistant message。
```

问题：streaming revision 和 final answer 不是同一个对象，surface 会重复或闪烁。

**正例**：

```text
message.id 表示同一条逻辑消息。
revision 表示内容和状态变化。
surface 按 message.id collapse。
```

### 例子三：审批状态

**反例**：

```text
approval 只存在 Run 内部或 Checkpoint 内部。
Web 通过 run stream 临时知道要显示审批卡。
```

问题：切换 surface 或恢复页面后，用户需要操作的状态消失。

**正例**：

```text
需要用户操作的状态必须进入 Conversation 可见层。
Message 或 Conversation control 表达 waiting approval。
```

### 例子四：调试审计

**反例**：

```text
因为执行事实流里有 message event，所以 Web 直接消费执行事实流。
```

问题：调试事实和用户事实混在一起，surface 被 run 内部细节污染。

**正例**：

```text
执行事实（agent_run 终态、product_tool_call 审计）用于 audit / replay / troubleshooting。
Conversation Messages 用于 surface。
```

### 例子五：新增概念

**反例**：

```text
发现 Lark 需要记录消息发送状态，于是定义 LarkMessage。
```

问题：Lark 投递状态不是新的消息本体。

**正例**：

```text
Message 是内容本体。
Delivery 是 surface 投递状态。
Delivery 引用 message.id。
```

## 红旗信号

出现以下情况时，Agent 应该暂停并重新审视设计：

- 同一个 PR 新增三个以上相似名词。
- 一个用户可见状态需要跨执行事实流、Checkpoint、Ledger 三处推断。
- Surface 需要知道 Run 内部 event 类型。
- 一个 message 的 id 在不同层使用不同规则生成。
- 一个 terminal 状态不在 Message 上表达，而靠旁路事件推断。
- 文档解释主流程时先解释 storage，再解释业务。
- 新类型名称里包含 storage 或 transport 名称，例如 `LedgerXxx`、`StreamXxx`、`CheckpointXxx`。
- 修一个消息 bug 必须同时修改 backend、framework、web、lark 四套不同 message parser。

出现这些情况说明概念债正在扩散，不能拿"系统复杂所以正常"当解释。

## 允许复杂的地方

这份指导思想不是要求系统简单到没有机制。

以下复杂度是允许的：

- 为了审计，Run 可以有执行事实流。
- 为了 replay，Conversation 可以用 append-only storage。
- 为了恢复，Run 可以有 Checkpoint。
- 为了多端投递，Surface 可以有 Delivery record。
- 为了性能，可以有 read model、cache、index。

但它们必须满足一条约束：

```text
它们不能重新定义核心领域对象。
```

## 不允许复杂的地方

以下复杂度不应该被接受：

- 每个 store 都有自己的 message type。
- 每个 surface 都有自己的 message lifecycle。
- 每个模块都能决定一条消息是否 done。
- 每个层都自己 parse content。
- 业务文档必须解释内部机制后才能解释用户行为。
- 新 agent 接手时必须先理解多个相似概念的历史原因。

这些复杂度不会让系统更强，只会让系统更脆。

## 文档写作准则

Agent 写架构文档时应遵循：

1. 先写业务对象，再写实现机制。
2. 先写不变量，再写流程。
3. 先写主心智，再写底层例外。
4. 不把 storage 名称放进主标题，除非该文档就是 storage 实现说明。
5. 不把机制图当成领域图。
6. 不用多个相似名词解释同一件事。
7. 每个新概念必须说明为什么已有概念不能表达。

## Code Review 准则

Agent 做 code review 时，除了找 bug，还要找概念债：

- 是否新增了同义模型？
- 是否让机制进入业务 API？
- 是否把用户可见状态藏在内部事件里？
- 是否把 delivery、render、checkpoint 状态混进 Message 本体？
- 是否没有统一 terminal state？
- 是否每层都有自己的 parser / normalizer？

这类问题即使当前测试通过，也应该作为架构风险指出。

## 设计决策顺序

每次设计时按这个顺序做决策：

```text
1. 领域对象是什么？
2. 不变量是什么？
3. 生命周期在哪里结束？
4. 谁需要读它？
5. 谁可以写它？
6. 哪些机制保存它？
7. 哪些 surface 投递它？
8. 哪些细节必须隐藏？
```

不要倒过来从数据库表、stream event、endpoint 或 UI component 开始。

## 最终准则

把这三句话作为每次执行前的默认检查：

```text
统一本体，不复制语义。
暴露业务，隐藏机制。
边界要硬，概念要少。
```

如果一个设计违反这三句话，即使它能跑，也应该被视为架构债。

## 关联页面

- [依赖注入](foundations/dependency-injection.md)：DI 是这套哲学在协作关系上的投影
- [标识符体系](foundations/identifiers.md)：实体主键与 runId 唯一执行身份
