---
id: runs.output-and-live-updates
title: Agent Run 输出与实时更新
status: design
owners: backend-runtime
summary: "Agent Backend 为 Agent Run 产生 Live Updates 和 outcome。Live Updates 只用于实时展示；terminal outcome 才提交最终 Message 到 Conversation History 和 Agent Context。"
depends_on:
  - conversation.history
  - agents.context
  - execution.agent-backend
used_by:
  - surfaces.web
  - surfaces.lark
  - flows.e2e-web-message
---

# Agent Run 输出与实时更新

Agent Backend 为一次 Agent Run 输出实时更新和 outcome。核心边界是：Live Updates 可以丢失，terminal outcome 才产生 canonical Message。

## Backend 输出什么

每个 run segment 有两条通道：

```ts
interface BackendRunSegment {
  events: AsyncIterable<BackendEvent>;
  outcome: Promise<BackendRunOutcome>;
}
```

`events` 用于实时展示和运行观测；`outcome` 可以是非终态 `suspended`，或 Agent Run 的唯一终态。

## Live Updates

Backend 把自己的原生事件映射为稳定更新，例如：

```text
text_delta
thinking_delta
native_tool_started
native_tool_completed
product_tool_started
product_tool_completed
pending_action
status
```

Product Backend 将这些更新发送给 Web/Lark。它们不直接写 Agent Context，也不作为 Conversation History 的事实。

Backend 独有信息使用 `backend.<kind>.*`，只用于诊断或增强 UI。

## Outcome 如何提交最终 Message

收到 `BackendRunOutcome` 后：

### completed

Product Backend 构造最终 assistant Message，并在同一数据库事务中：

```text
写 Conversation History
追加 Agent Context Message ref
更新 Context Branch
更新内部 execution session 同步点
标记 Agent Run completed
```

事务成功后才能释放 branch run lock 和处理 follow-up。

### suspended

Backend 可以把原生 approval/question 表达为 `PendingAction`。Product Backend 将 Agent Run 置为 waiting，保存 action 并保留 branch ownership。

用户响应后继续同一个 Agent Run。只有后续 outcome 为 completed/failed/aborted/timeout 才 terminal；同一个 actionId 只能消费一次。

### failed / aborted / timeout

Product Backend 记录 Agent Run 终态与诊断。是否写用户可见错误 Message 由产品策略决定，但不能把失败误标为成功。

## Product Tool 结果何时写入 Context

Product Tool 由 Product Backend 执行。语义相关 call/result 可以：

- 作为当前 Agent Run 的 tool result 返回；
- 追加到 Agent Context；
- 如需多人可见，再写 Conversation History。

非语义工具状态只进入运行事件或审计。

## 新输入如何排队

同一 Context Branch 同时最多一个 active run。新输入：

- normal：branch 空闲时开始；
- steer：希望尽快影响当前 Run；Backend 支持时可立即转发；
- follow-up：当前 Agent Run terminal 后发送。

Agent Backend 内部 sub-agent 属于同一 Agent Run，不占用额外 Context Branch run。

## 断线或进程重启后如何恢复

客户端断线不影响事实。Live Updates 可以丢失；重连后：

- 已完成内容从 Conversation History 恢复；
- active Run 从 Product Backend 状态恢复；
- Agent Context 从持久数据恢复；
- 内部 execution session 丢失时从 Agent Context 重建。

## 不变量

1. Terminal outcome 是 Agent Run 完成唯一依据。
2. `suspended` 不是 terminal outcome。
3. Streaming event 不直接成为 canonical Message。
4. completed Agent Run 的 History Message + Context ref 必须原子提交。
5. Backend 私有事件不能驱动核心业务状态机。
6. branch lock 在 terminal commit 后释放。
7. follow-up 在当前 Agent Run 完成后处理。
## 关联页面

- [Conversation History](../conversation/history.md)
- [Agent Context](../agents/context.md)
- [Agent Backend](../execution/agent-backend.md)
- [Web 消息端到端](../flows/e2e-web-message.md)
