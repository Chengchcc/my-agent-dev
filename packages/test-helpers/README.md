# @chengchenccc/test-helpers

给测试用的 model test double。它提供一个按脚本回放的假 `ChatModel`，让你在不调真实 API 的情况下测试 agent 的行为。

## 为什么需要它

agent 的运行内核以 `ChatModel` 接口为中心。测试这套内核时，最大的麻烦就是模型本身：真实模型要密钥、要联网、慢、且每次输出不一样，没法写确定性断言。

解决办法是给测试一个完全可控的 test double——它不思考，只按事先写好的脚本，一轮一轮回放预设的文字或工具调用。这样测试就能精确控制模型在第几轮说什么、调哪个工具、传什么参数，从而稳定地验证 agent 循环、工具执行、插件等下游逻辑。这个包只做这一件事。

## 核心概念

**EchoScript。** 描述这个假模型预设输出的脚本结构。它就是一个对象，含一个 `turns` 数组，每个元素是两种之一：

- `{ type: "text"; text: string }` —— 这一轮模型输出一段文字。
- `{ type: "tool_call"; id: string; name: string; input: unknown }` —— 这一轮模型发起一次工具调用。

**echoModel。** `echoModel(script)` 接受一个 `EchoScript`，返回一个实现了 `ChatModel` 的对象（`id` 为 `"echo"`）。它的回放规则很简单：每次调用 `stream` 时，数它收到的消息里有几条 assistant 消息，以这个数作为「当前轮次」，取脚本里对应的那一项；轮次超出脚本长度时，固定回放最后一项。

- 文字项：吐出一个 text delta，再吐一个 `done`（`stopReason: "end_turn"`）。
- 工具调用项：先吐 `tool_use`（带 id、name），再吐 `input_json_delta`（把 `input` 序列化成 JSON），最后吐 `done`（`stopReason: "tool_use"`）。

因为轮次是从历史消息里数出来的，把同一个 echoModel 接进 agent 循环，就能驱动出「先调工具、再根据结果说话」这类多轮交互。

## 怎么用

```ts
import { echoModel, type EchoScript } from "@chengchenccc/test-helpers";

const script: EchoScript = {
  turns: [
    { type: "tool_call", id: "call-1", name: "read", input: { path: "/SOUL.md" } },
    { type: "text", text: "读完了，这是一个测试 agent。" },
  ],
};

const model = echoModel(script);
// 把 model 作为 ChatModel 传给 createAgent / createGenericAgent，即可写确定性测试
```

## 依赖关系

test-helpers 只依赖 core（拿 `ChatModel`、`Message`、`AIMessageChunk` 等类型）。它是测试期工具，仓库里没有其他包在生产依赖中引用它。
