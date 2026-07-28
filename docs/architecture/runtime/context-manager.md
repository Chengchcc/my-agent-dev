---
id: runtime.context-manager
title: 上下文管理器
status: current
owners: architecture
last_verified_against_code: 2026-07-28
summary: "上下文管理器（公开 API 别名 ContextPipeline）是 spanLoop 在每次调模型「之前」对消息历史做整形的那一道关口。它只有一个方法 shape：拿到完整线程消息，返回一份「这次该喂给模型」的消息。Agent 自带 5 种实现（透传、滑动窗口、token 预算、工具结果截断、结构化摘要压缩），可用 pipeContextManagers 串联。Agent 默认装配为 toolResultTruncator + summarizingContextManager（含 structuredSummarize）。它和插件的 beforeModel 钩子分工明确：先 beforeModel 注入记忆/技能，再 shape 决定最终发送形状（M22 修复后 finalMsgs 就是 shaped 结果，预算不再「瞎」）。"
depends_on:
  - runtime.framework
used_by:
  - runtime.plugin
---

# 上下文管理器

上下文管理器是 spanLoop 在每次调模型「之前」对消息历史做整形的那一道关口。它只有一个方法 `shape`：拿到完整线程消息，返回一份「这次该喂给模型」的消息。运行时内部类型仍叫 `ContextManager`（`packages/agent/src/context/context-manager.ts`），公开 API 通过 `@my-agent-team/agent` 的导出别名为 `ContextPipeline`（`export type { ContextManager as ContextPipeline }`）--两个名字指同一个接口。框架自带 5 种实现，可用 `pipeContextManagers` 串联；但默认装的是透传，即「什么都不改」。

## 为什么需要这一层

模型的上下文窗口是有限的，而线程消息会随运行无限增长。总得有人决定：当历史太长时，砍掉哪些、保留哪些、要不要先压成摘要。把这个决定**单独抽成一道关口**，而不是散在循环里，好处是它可以被替换、被组合、被单独测试--循环本体只管「调用它」，不管它具体怎么裁。

它刻意只暴露一个方法：

```ts
interface ContextManager {
  shape(ctx: ContextManagerContext, messages: readonly Message[]): Message[] | Promise<Message[]>;
}
```

`messages` 是只读的完整线程历史，返回值是「本次模型调用应该看到的消息」。注意 `shape` **不持久修改线程**--它的产出只用于这一次模型调用，线程里的真实历史保持不变。这一点和[账本是唯一事实](../foundations/facts-and-projections.md)的原则一致：整形是投影式的临时变换，不是对事实的改写。

## 调用点：每次调模型之前

`shape` 在 spanLoop 里的位置是固定的--`packages/agent/src/runtime/span-loop.ts`，模型调用前：

```ts
const shaped = await rt.contextManager.shape(
  { sessionId, signal, logger, model },
  rt.thread.messages,
);
const finalMsgs = await rt.plugins.fireBeforeModel(shaped);
// ... model.stream(finalMsgs, ...)
```

顺序是关键（M22 已修复为）：**先 `beforeModel`，再 `shape`**。插件的 `beforeModel` 钩子先把记忆、技能索引、系统提示等临时内容注入线程消息，上下文管理器再对注入后的完整消息做裁剪/压缩/截断，产出最终发送给模型的消息。两者职责不重叠：

- `beforeModel` 管**临时的注入**--把记忆/技能拼进去，对象是「这次额外要带的东西」。
- `shape` 管**最终发送形状**--对注入后的完整消息做裁剪、压缩、截断，对象是「注入之后的整体」。

```mermaid
flowchart LR
  T[thread.messages<br/>完整历史] --> B[plugins.beforeModel<br/>注入记忆/技能]
  B --> S[contextManager.shape<br/>裁剪/压缩最终payload]
  S --> M[model.stream]
```

### M22 修复：预算不再「瞎」

早期版本中 `shape` 在 `beforeModel` 之前执行，导致 token 预算只对 `thread.messages` 计数，而真正发给模型的 `finalMsgs` 还包含 `beforeModel` 注入的记忆/技能--整形器看不到注入的部分，预算不准。M22 将顺序反转：`beforeModel` 先注入，`shape` 再对完整 payload 做整形。现在 `finalMsgs` 就是 `shape` 的产出，整形器的预算覆盖了最终发给模型的一切，不再有「注入撑爆窗口」的风险。

## 自带的 5 种实现

框架在 `packages/agent/src/context/` 提供 5 种现成实现，各管一种「太长了怎么办」：

| 实现 | 策略 | 触发与产出 |
|------|------|-----------|
| `passthroughContextManager` | 透传 | 原样返回，什么都不改。**这是默认值。** |
| `slidingWindowContextManager` | 滑动窗口 | 按「轮次」保留最近 N 轮（`maxTurns`），可选保留最前 `keepFirst` 条；丢弃中间的旧轮次 |
| `tokenBudgetContextManager` | token 预算 | 从最新往回累加，直到逼近 `maxTokens - reserveForOutput`，砍掉装不下的旧消息 |
| `toolResultTruncator` | 工具结果截断 | 不删消息，只把超过 `maxCharsPerResult` 的 `tool_result` 内容尾部截短并标注截断量 |
| `summarizingContextManager` | 摘要压缩 | token 超过 `triggerAt` 时，把旧消息交给模型压成一条摘要，拼回最近 `keepRecent` 条之前 |

后三种都涉及「删/改消息」，因此都用 `repairToolPairs` 兜底：压缩或裁剪可能把一对 `tool_use` / `tool_result` 拆散在边界两侧，`repairToolPairs` 负责修复这种悬空配对，避免给模型喂出不合法的消息序列。

### 结构化摘要（M22 起为 Agent 默认）

M22 之前，`summarizingContextManager` 的默认摘要器（`defaultSummarize`）产出的是自由文本--把旧消息追加一句「concisely summarize…」的指令丢给模型，取回纯文本，包成一条 `user` 消息：

```ts
return { role: "user", text: `[Earlier conversation summary]: ${text}` };
```

自由文本摘要没有「目标 / 约束 / 进度 / 决策 / 下一步」这类结构化分区，信息密度低且不易被下游提取。

M22 引入了 `structuredSummarize` 摘要器，按固定分区（目标、约束、进度、决策、下一步）产出结构化摘要，信息密度和可提取性显著提升。Agent 默认装配 `summarizingContextManager` 时使用 `structuredSummarize`，不再依赖自由文本默认摘要器。`SummarizingOptions.summarizer` 仍可被调用方覆盖以换回自由文本或其他自定义实现。

## 组合：pipeContextManagers

多个管理器可以用 `pipeContextManagers` 串成一个，按顺序逐个 `shape`，前一个的输出是后一个的输入：

```ts
pipeContextManagers(
  toolResultTruncator({ maxCharsPerResult: 4000 }),  // 先把巨型工具结果压扁
  tokenBudgetContextManager({ maxTokens: 128000 }),  // 再按总预算裁
);
```

这让「先截断单条、再控总量」这类组合策略不必写成一个大实现--每个管理器只关心一件事。

## Agent 默认装配（M22 起）

M22 之前，`createAgent` 的默认上下文管理器是 `passthroughContextManager()`（即不裁剪），Agent 默认装配也没有覆盖它。M22 起，Agent 默认装配了上下文压缩管道：

```ts
pipeContextManagers(
  toolResultTruncator({ maxCharsPerResult: 4000 }),   // 先截断巨型工具结果
  summarizingContextManager({ summarizer: structuredSummarize }),  // 再结构化摘要压缩
);
```

这样通用 Agent 默认就具备上下文压缩能力：工具结果先被截断到合理长度，历史再被结构化摘要压进窗口。调用方仍可通过 `config.contextManager` 覆盖此默认值。

## 关联页面

- [Agent 运行循环](framework.md)
- [运行时插件机制](plugin.md)
- [Agent 编排层](../harness/harness.md)
- [事实与投影](../foundations/facts-and-projections.md)
- [未来工作](../roadmap/future-work.md)
