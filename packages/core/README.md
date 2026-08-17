# @chengchenccc/core

定义 agent 系统最底层的协议类型与 stream utilities。整个仓库里所有跟"消息""模型""工具"打交道的代码，最终都对齐到这里的类型。

## 为什么需要它

一个 agent 系统里有很多角色：模型适配器、工具、对话框架、运行时、后端。如果每一层都自己定义"什么是一条消息""工具长什么样"，它们之间就无法拼装。`core` 的职责就是把这套词汇固定下来：消息、内容块、模型接口、工具接口。它故意保持精简——没有任何运行时依赖，不绑定任何具体的模型厂商，也不掺杂权限、上下文裁剪这些上层关注点（那些属于 Oma Runtime 所在的 `packages/agent`）。

可以把 `core` 理解成协议层：它规定形状，不规定行为。

## 核心概念

**Message 与 ContentBlock。** 一条 `Message` 有 `role`（`"system" | "user" | "assistant" | "tool"`）和可选的 `blocks`。内容块有三种：`TextBlock`（文本）、`ToolUseBlock`（模型发起的工具调用，带 `id`/`name`/`input`）、`ToolResultBlock`（工具结果，通过 `tool_use_id` 回指那次调用，可带 `is_error`）。一轮对话就是这些消息的有序列表。

**ChatModel。** 模型只需要实现一个流式接口：`stream(messages, options?)` 返回 `AsyncIterable<AIMessageChunk>`。每个 chunk 携带一个可选的 `delta`（文本、推理 reasoning、工具调用开始 tool_use、或工具入参的 JSON 增量 input_json_delta），以及可选的 `done`/`stopReason`/`usage`。模型还可以选配只读的 `id` 和 `countTokens`。这个接口刻意只描述"如何产出 token 流"，至于怎么对接 Anthropic 之类的厂商，是 `packages/ai` 适配器的事。

**Tool。** 一个工具是 `name` + `description` + `inputSchema`（JSON Schema 形态的 `Record<string, unknown>`）加上一个 `execute(input, signal?)` 方法。`execute` 返回 `ToolExecuteResult`（`content` 字符串，可选 `isError`），允许同步或异步。

**stream-utils。** `collectStream`（把整条流一次性收集成 `{ blocks, stopReason, usage }`）、`mergeChunkIntoBlocks`、`finalizeToolUseInputs` 是对 chunk 流做折叠的辅助函数，供上层复用。

> 模型/工具循环本身不在这里——`packages/agent` 的 Oma Runtime 是唯一真实 loop。

## 依赖关系

`core` 不依赖仓库里任何其他包，是整个系统的地基。它被 Oma（`packages/agent`、`apps/oh-my-agent`、`packages/adapter-oma-agent`）、`packages/ai`、`packages/adapter-mcp`、`packages/tools-common` 与 `apps/backend` 消费。
