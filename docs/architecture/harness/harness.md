---
id: harness.harness
title: Agent - Agent 编排层
status: current
owners: architecture
last_verified_against_code: 2026-07-28
summary: "Agent 把运行时的 Agent + 拆分后的持久化端口（MessageStore / EventLog / InterruptStore）+ 插件系统 + ContextPipeline 组成为一个有生命周期管理（prompt/continue/resume/abort）和自动化维护（retry/compaction）的运行时单元。它是旧 harness 层与旧 framework 层合并后的唯一编排入口。"
depends_on:
  - runtime.framework
  - runtime.plugin
  - runtime.context-manager
used_by:
  - flows.e2e-web-message
  - flows.e2e-lark-message
  - flows.e2e-issue-lifecycle
  - backend.overview
---

# Agent

Agent 是 Agent 的运行时编排。它不是领域对象--它是已有领域对象的胶水，把构造、运行、事件分发、维护操作封装成一个类。Backend 通过 `createAgentSession()` 创建 Agent 并调用 `prompt()`，运行循环在 Backend 进程内执行。

> **P11 起**：旧的 `harness` 与 `framework` 两个包已合并进 `packages/agent`。原来的 `AgentSession` 类重命名为 `Agent`，旧的 `Checkpointer` 复合接口拆分为 `MessageStore` + `EventLog` + `InterruptStore` 三个端口。本文页路径仍为 `harness/harness.md`（保持 concepts.json 与既有链接稳定），内容已同步为当前实现。

## 构造

```
Agent(config):
  -> new Agent({ model, sessionId, tools, plugins, messageStore, eventLog, interruptStore, contextManager, logger, systemPrompt })
  -> agent.subscribe(#handleEvent)
  -> 初始化 steer/followUp 队列 + retry/compaction 状态
```

构造参数（`AgentConfig`，定义于 `packages/agent/src/agent-options.ts`）：

| 参数 | 类型 | 来源 |
|------|------|------|
| `model` | `ChatModel` | Backend 从 agent DB row 构造 |
| `sessionId` | `string` | `{conversationId}:{memberId}` |
| `tools` | `Tool[]` | Backend 创建（闭包持有 cwd、convPort 等上下文） |
| `plugins` | `Plugin[]` | `identityPlugin`, `ConversationContextPlugin`, `fsMemoryPlugin`, `progressiveSkillPlugin`, `taskGuardPlugin` |
| `messageStore` | `MessageStore` | 全局 `dataDir/checkpointer.db`，按 `sessionId` 分区 |
| `eventLog` | `EventLog` | 同库 `checkpoint_events` 表，记录执行事实事件 |
| `interruptStore` | `InterruptStore` | 同库 `checkpoint_interrupts` 表，保存中断状态 |
| `contextManager` | `ContextPipeline` | `pipeContextManagers(toolResultTruncator, autoSummarize)` |
| `session` | `Session` | 可选，树结构持久化，支持 fork/回溯/可逆压缩 |

旧版单一 `checkpointer: Checkpointer` 参数已被拆分为 `messageStore` / `eventLog` / `interruptStore` 三个端口，分别承担消息存取、事件追加、中断状态保存。`createAgentSession()` 是 SDK 层的便捷入口（`packages/agent/src/agent-sdk.ts`），内部解析 `ModelRef` 后委托给 `new Agent(...)`，并可选地通过 `SessionManager` 复用既有 session。

Agent 通过 `agent.subscribe()` 注册一个内部订阅者，在运行循环发射每个事件时处理副作用：通知外部 listeners、检查 retry/compaction 条件、包装 `agent_end` 的 `willRetry` 字段。

## 生命周期

一次 run 的完整生命周期：

```
dispatch:
  agent = await createAgentSession({...})
  await agent.prompt(input)
  agent.dispose()

resume（工具触发 InterruptSignal 后暂停）:
  agent = agents.get(runId)
  await agent.resume({ approved: true/false })
  // agent_end（非中断）后 dispose
```

Backend 维护 `Map<runId, Agent>` 以便 resume 时查找。Agent 被中断后保持存活--只存在 `agent_end`（真正的结束，非中断）时才 dispose。

## prompt() 流程

```
prompt(text)
  ├── Agent 正在 streaming? -> 消息放入 steer/followUp 队列 -> return
  └── 非流式 -> #execute(text)
      ├── agent.run(text) / agent.continue()
      ├── while (postRunNeedsContinue)
      │   ├── retryable error? -> backoff -> agent.continue()
      │   │   └── 当前 assistant message 的 MessageRevision.runStatus = "retrying"
      │   ├── overflow? -> compact() -> agent.continue()
      │   │   └── 当前 assistant message 的 MessageRevision.runStatus = "compacting"
      │   ├── threshold? -> compact() -> return
      │   └── queued messages (steer/followUp)? -> agent.continue()
      └── return
```

## 内部订阅者

`#handleEvent` 处理运行循环发射的每个事件：

```
#handleEvent(event):
  ├── message_start (user) -> 从 steer/followUp 队列中移除对应文本
  ├── message_end -> 通知外部 listeners
  │   ├── role=assistant -> 记录 #lastAssistantMessage（供 post-run 检查用）
  │   └── terminal -> 检查 retry/compaction 条件
  ├── agent_end -> 包装 willRetry 字段 -> emit
  ├── interrupted -> 标记 run 暂停，等待 resume
  └── tool_execution_start/update/end -> 透传给外部 listeners
```

## 事件

Agent 发射给外部 listener 的事件类型：

```typescript
type AgentEvent =
  // 运行循环核心事件（agent_end 被增强--加了 willRetry）
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: Message[]; willRetry: boolean }

  // 队列状态变更
  | { type: "queue_update"; steering: string[]; followUp: string[] }

  // 上下文压缩
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason; result?; aborted; willRetry; errorMessage? }

  // 自动重试
  | { type: "auto_retry_start"; attempt; maxAttempts; delayMs; errorMessage }
  | { type: "auto_retry_end"; success; attempt; finalError? }
```

外部 listener 由调用方（conversation、orchestrator、cron）在 `startAgentRun` 时提供。不同调用方根据事件类型执行不同的持久化和推进逻辑--conversation 写入消息到账本、orchestrator 推进 Issue 状态机、cron 标记任务完成。

## compact()

上下文压缩--调用 LLM 将老消息总结为一段摘要文本，替换原来的消息前缀：

```
compact(customInstructions?)
  -> messageStore.load(sessionId) -> messages
  -> 计算 token 用量，确定压缩边界（保留最近 N 条，summarize 前面的）
  -> LLM summarize(messages[0..N-10])
  -> summaryMessage = { role: "user", text: "[Earlier summary]: ..." }
  -> messages = [summaryMessage, ...messages[N-10:]]
  -> messageStore.save(sessionId, messages)
  -> agent 核心线程 messages 替换为新的消息列表
  -> emit compaction_end
```

与 `autoSummarize`（contextManager 管道里的自动预防）的区别：`compact()` 是 overflow 后的修复操作或用户手动触发的显式操作--两者在不同层协作，不互相替代。

## 错误处理

| 场景 | 行为 |
|------|------|
| compact() 中 LLM 调用失败 | 保留原 messages，压缩放弃，日志告警 |
| retry 耗尽（3次） | `agent_end` 携带 error + `willRetry: false` |
| prompt() 期间 abort | `agent.abort()` 终止当前 run，跳过 post-run 处理 |
| overflow -> compact -> 再次 overflow | 停止，告警 |
| steer/followUp 在 retry 等待期间到达 | 保留在队列，retry 成功后注入 |

## 关联页面

- [Agent 运行循环](../runtime/framework.md)
- [上下文管理器](../runtime/context-manager.md)
- [运行时插件机制](../runtime/plugin.md)
- [Web 消息端到端](../flows/e2e-web-message.md)
- [ConversationContextPlugin](conversation-context-plugin.md)
- [依赖注入](../foundations/dependency-injection.md) -- DI 手法与 executeAgentRun 诊断
- [标识符体系](../foundations/identifiers.md) -- sessionId 归属与 Agent 跨 run 持久
