---
id: runs.output-and-live-updates
title: Agent Run 输出与实时更新
status: current
owners: backend-runtime
summary: "oma 子进程为一次 Agent Run 产生实时更新和唯一 outcome。Live Updates 可以丢失；terminal BackendRunOutcome（completed/failed/aborted/timeout）才产生 canonical Message。无 suspended 终态。"
depends_on:
  - conversation.history
  - agents.context
  - execution.oma-backend
used_by:
  - surfaces.web
  - surfaces.lark
  - flows.e2e-web-message
---

# Agent Run 输出与实时更新

oma 子进程为一次 Agent Run 输出实时更新和 outcome。核心边界：Live Updates 可以丢失，terminal outcome 才产生 canonical Message。

## 子进程输出什么

```ts
interface BackendRunSegment {
  events: AsyncIterable<BackendEvent>;
  outcome: Promise<BackendRunOutcome>;
  stop(): Promise<void>;
}

type BackendRunOutcome =
  | { status: "completed"; output?: Message; usage?: Usage }
  | { status: "failed" | "aborted" | "timeout"; error?: string; usage?: Usage };
```

`events` 用于实时展示和运行观测；`outcome` 是 Agent Run 的唯一终态。**没有 `suspended`** —— 审批/问答通过 Product Tools MCP 同步等待，Product Backend 把待响应事项持久化为 `pending_action`，但 Run 协议只有四个终态。

## Live Updates

Adapter 把子进程事件映射为稳定更新：

```text
text_delta
thinking_delta
native_tool_started / native_tool_completed
product_tool_started / product_tool_completed
pending_action
status
```

Product Backend 将这些更新通过 SSE 发送给 Web/Lark。它们不写 Agent Context，也不作为 Conversation History 的事实。子进程独有信息使用 `backend.oma.*`，只用于诊断或增强 UI。

## Outcome 如何提交最终 Message

收到 `BackendRunOutcome` 后：

### completed

Product Backend 构造最终 assistant Message（MessageRevision，messageId = `run:<runId>:assistant:0`），并在同一数据库事务中：

```text
写 Conversation History（agent_run_id 提交标记）
追加 Agent Context Message ref
更新 Context Branch
标记 Agent Run completed（terminal_result）
```

事务成功后才能释放 branch run lock 和处理 follow-up。

### failed / aborted / timeout

Product Backend 记录 Agent Run 终态与诊断。是否写用户可见错误 Message 由产品策略决定，但不能把失败误标为成功。

## Product Tool 结果何时写入 Context

Product Tool 由 Product Backend 执行（`product_tool_call` 幂等/审计）。语义相关 call/result 可以：

- 作为当前 Agent Run 的 tool result 返回；
- 追加到 Agent Context；
- 如需多人可见，再写 Conversation History。

非语义工具状态只进入运行事件或审计。

## 新输入如何排队

同一 Context Branch 同时最多一个 active run。新输入：

- normal：branch 空闲时开始；
- steer：希望尽快影响当前 Run；Adapter 立即转发给 live child；
- follow-up：当前 Agent Run terminal 后开始新 Run。

## 断线或子进程崩溃后如何恢复

客户端断线不影响事实。Live Updates 可以丢失；重连后：

- 已完成内容从 Conversation History 恢复；
- active Run 从 Product Backend 状态恢复（queue 重投按 delivery idempotency 去重）；
- 子进程崩溃 = 当前 Run failed；下一个输入 = 新 Run = 从 Agent Context full projection 重建。

没有 execution session 需要恢复 —— 它本来就不存在。

## 不变量

1. Terminal outcome 是 Agent Run 完成唯一依据。
2. Streaming event 不直接成为 canonical Message。
3. completed Agent Run 的 History Message + Context ref 必须原子提交。
4. `backend.oma.*` 私有事件不能驱动核心业务状态机。
5. branch lock 在 terminal commit 后释放。
6. follow-up 在当前 Agent Run 完成后处理（新 Run、新子进程）。

## 关联页面

- [Conversation History](../conversation/history.md)
- [Agent Context](../agents/context.md)
- [Agent Backend](../execution/agent-backend.md)
- [Web 消息端到端](../flows/e2e-web-message.md)
