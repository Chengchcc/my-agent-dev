# @my-agent-team/harness

AgentSession 编排层——把 Agent + Checkpointer + PluginRunner + ContextManager 组合为一个有清晰生命周期的单元，提供 retry、compaction、事件订阅与中断/恢复能力。

## 为什么需要它

framework 的 `createAgent()` 提供了通用的 agent 运行内核，但不关心"这个 agent 怎么出生、怎么压缩上下文、怎么在中断后恢复"。harness 提供这一层策略：

- **AgentSession** 封装了一次 agent 调用的完整生命周期：`prompt()` → 内部重试+自动压缩循环 → dispose（或保持 alive 等待 resume）。
- **compactThread** 执行 LLM 驱动的上下文压缩，将早期消息概括为摘要，保留最近 N 条。
- **identityPlugin**（独立包 `plugin-identity`）负责读取工作区文件、注入系统提示。

## 核心导出

| 导出 | 说明 |
|------|------|
| `AgentSession` | Agent 编排类，prompt/continue/resume/abort/compact |
| `compactThread(opts)` | LLM 驱动压缩，返回压缩后的 messages + 结果 |
| `reflectionGuidance()` | 反思引导提示文本 |
| `verificationGuidance()` | 冷评审引导提示文本 |

## 怎么用

```ts
import { AgentSession } from "@my-agent-team/harness";
import { AnthropicChatModel } from "@my-agent-team/adapter-anthropic";

const session = new AgentSession({
  model: new AnthropicChatModel({ model: "claude-opus-4-7" }),
  threadId: "session-001",
  plugins: [/* identityPlugin, fsMemoryPlugin, etc. */],
  checkpointer: sqliteCheckpointer({ db: "checkpointer.db" }),
  contextManager: composeContextPipeline(/* ... */),
});

session.subscribe((event) => {
  if (event.type === "message") { /* write to ledger */ }
  if (event.type === "agent_end") { /* run complete */ }
});

await session.prompt("Hello");
// Agent runs through retry/compaction loop
// On interrupt (waiting state): session stays alive for resume
// On completion: dispose or keep for approval
```

## 依赖

harness 依赖 `core`、`framework`、`message`。它不依赖任何特定 plugin——插件由调用方（backend）装配后传入。
