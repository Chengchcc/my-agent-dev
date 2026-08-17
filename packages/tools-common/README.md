# @chengchenccc/tools-common

Agent 与外界交互的标准工具：bash、文件读写编辑、grep、glob、网络、搜索。

## 核心概念

**cwd 工具工厂。** 文件操作基于工作目录：

- `createReadTool({ cwd })`、`createWriteTool({ cwd })`、`createEditTool({ cwd })` 分别返回名为 `read` / `write` / `edit` 的工具。路径校验：用户路径 resolve 后必须在 cwd 之下，越界返回 `isError: true`。`edit` 的语义是精确字符串替换。
- `withDefaultCwd(tool, cwd)` 为任意工具在调用方未提供 `cwd` 时填入默认值。

**独立工具：**

- `bashTool` —— 用 `setsid` 起新进程组，默认超时 30s
- `grepTool` —— 底层 ripgrep，需系统装有 `rg`
- `globTool` —— 基于 `Bun.Glob`，结果上限 500 条
- `webFetchTool` —— 抓取 URL 返回纯文本，内置 URL 检查与超时
- `createWebSearchTool(apiKey)` —— Tavily 搜索，返回 top 结果 JSON

**AgentFsLike。** agent 工具依赖的最小文件系统接口，定义在 `agent-fs-like.ts`。插件内部使用，一般不需要直接 import。

## 怎么用

```ts
import { createReadTool, createWriteTool, bashTool } from "@chengchenccc/tools-common";

const read = createReadTool({ cwd: "/data/agents/abc" });
const write = createWriteTool({ cwd: "/data/agents/abc" });

await write.execute({ path: "output.txt", content: "hello" });
const result = await read.execute({ path: "output.txt" });
// result.content === "hello"
```

## 依赖

tools-common 只依赖 core（拿 `Tool` 类型）。被 harness、plugin-fs-memory、plugin-progressive-skill 使用。
