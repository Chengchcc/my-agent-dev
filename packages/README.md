# Packages

`packages/` 是整个 agent 系统的可复用内核，按职责从底到上分层：最底下是协议/契约类型，往上是 Oma Runtime、执行链 adapter、模型系统与插件，再到一组工具与测试设施。`apps/` 下的后端与各 surface 都是把这些包拼起来用。

设计上的一条主线是：**依赖只能向下**。`core` 处在最底层且零依赖，所有人都对齐到它定义的模型、工具类型；越往上的包越"有主张"，但永远不会被下层反向依赖。

## 唯一执行链

```text
Product Backend (apps/backend)
→ Agent Run
→ Adapter (adapter-oma-agent)
→ spawn 一次性 oma 子进程 (apps/oh-my-agent)
→ per-Run Runtime (agent)
→ BackendRunOutcome (agent-backend 契约)
→ Product terminal commit
```

## 分层导航

**协议与契约（零运行时依赖）**

- [`core`](./core/)：`ChatModel`、`Tool`、`AIMessageChunk`、`ContentBlock` 与 stream-utils（`collectStream` 等）。协议层，不含 run loop——唯一真实 loop 在 `agent`。
- [`message`](./message/)：`Message` / `MessageRevision` 领域类型、zod 序列化、`assistantMessageId(runId, ordinal)` → `run:<runId>:assistant:<n>`。
- [`conversation`](./conversation/)：多方会话领域模型——`LedgerEntry`/`LedgerKind` codec、成员、@mention 触发规则。
- [`agent-backend`](./agent-backend/)：Agent Backend 执行契约——`BackendRunInput`/`BackendRunOutcome`/`BackendRunSegment`、核心事件、JSONL transport schema 与事件/outcome mapping（两侧共用同一份）。
- [`api-contract`](./api-contract/)：Elysia `App` 类型真源（HTTP/SSE 契约）、`SSEEventMap`。
- [`config`](./config/)：环境变量 schema 与解析。

**Runtime 与执行链**

- [`agent`](./agent/)：**Oma 唯一真实 Runtime**——`createOmaSession()`（model/tool loop、retry、compaction、插件、todo）、in-memory SessionStore、prompt/meta 构建。
- [`adapter-oma-agent`](./adapter-oma-agent/)：`OmaBackend`——spawn child、stdin/stdout JSONL、steer/abort、并发上限、stderr 脱敏、child recycle。
- [`ai`](./ai/)：Provider 注册制 + Model 元数据 + `createModelRuntime()` + `AnthropicChatModel`——全仓唯一直接 import 模型 SDK 的地方。

**插件（Oma 加载的真实能力）**

- [`plugin-progressive-skill`](./plugin-progressive-skill/)：SKILL.md 渐进式加载，按 Run 冻结的 `skillRoots` 扫描，按需分页喂给模型。
- [`plugin-todo`](./plugin-todo/)：Run-local todo 跟踪（规划 + 进度 + 停止前把关）。

**工具与适配器**

- [`tools-common`](./tools-common/)：标准工具实现——bash、文件读写编辑、grep、glob、网络、cwd 工具工厂。
- [`adapter-mcp`](./adapter-mcp/)：MCP client 管理 + 工具适配（`mcp__{serverName}__{toolName}` 命名）。

**测试**

- [`test-helpers`](./test-helpers/)：`echoModel()` 等确定性的 ChatModel 测试替身。

**状态机**

- [`loop`](./loop/)：Loop 状态机（纯 reducer，无 I/O；编排在 apps/backend）。

## 从哪读起

- **想理解整体**：`core` → `agent-backend` → `adapter-oma-agent`，这条线就是执行链。
- **想加插件**：先看 `agent` 的插件契约，再照着 `plugin-todo` / `plugin-progressive-skill` 抄结构。
- **想接新模型厂商**：看 `ai` 的 Provider 接口，照着 `AnthropicChatModel` 写适配器。
- **在做后端**：`agent-backend`（契约）→ `adapter-oma-agent`（child 边界）→ `apps/backend` 的 agent-run feature（执行编排）。
