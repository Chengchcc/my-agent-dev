# ADR 0027: ask_question 作为 Product Tools MCP 工具（跨 runtime HITL 提问）

## 状态

Draft（2026-09-06；设计确认后转 Accepted）

## 上下文

### 问题

oma 原生 `ask_question` 工具（`apps/oh-my-agent/src/core/tools/ask-question.ts`）执行依赖 `options.ask`，而该 handler **只在 TUI 模式接线**（`tui-mode.ts` → `io.askQuestions`）。backend 以 `--mode rpc` spawn oma child，`rpc-mode.ts` 没有 ask 传输，`opts.ask` 恒为 `undefined` → 工具 **fail-closed** 返回 `{"error":"no ask pipeline configured"}`（实测对话 `78fa86d5…`：agent 想确认"结果写到哪个文档"，ask 失败后退化为自行决定）。

### 为什么必须走 MCP 注入（而非 RPC 原生）

- **RPC 原生 ask**（在 `rpc-mode.ts` 加 `ask_request`/`resolve_ask` 命令）只对 **oma** 生效。`claude` / `pi` / `omp` 是外部 CLI，走各自 adapter（`adapter-claude-agent` / `adapter-pi-agent`），**不经 oma 的 JSONL 协议**，没有 `ask_question` 工具、没有 `options.ask` 概念。四个 runtime 里三个会失去 ask 能力。
- **MCP 注入**走**共享**的 `packages/adapter-mcp`（`mcp-client-manager.ts` 的 `callTool(serverId, toolName, args): Promise<unknown>`），所有 runtime 都用它挂 product-tools MCP（ADR 0020/0022 已确立）。backend 已在 `product-tools` MCP 注入 `todo_write`（`buildHistoryTools`），并写进 workspace `.mcp.json` —— 注释明确"backend can inject its own MCP ask_question (product surfaces)"。

**结论：ask_question 实现为 Product Tools MCP 工具，是唯一跨 oma/claude/pi/omp 通用的路径。**

### 为什么可行（关键机制已存在）

- `product-tools/mcp.ts` 的 `CallToolRequestSchema` handler 已 `await service.call(...)`（mcp.ts:200），service 可安全 **block 在一个 parked resolver** 上，等 web 答题后唤醒。
- 这正是 oma approval 的 **await-until-resolved 模式**（`apps/oh-my-agent/src/modes/rpc/rpc-mode.ts:99` `pendingApprovalsByRun` + `:259-275` emit `approval_request` + `resolve_approval` 命令唤醒），同一思想，只是搬到 **backend MCP 层**，从而所有 runtime 共享。
- 唯一的特殊点：ask 有**人类参与**，MCP 工具必须等 web 答题；`todo_write` 等工具无此需求。

## 决策

### ask_question 实现为 Product Tools MCP 工具

`apps/backend/src/features/product-tools/manifest.ts` 的 `buildHistoryTools` 增加 `ask_question` 条目（与 `todo_write` 同构）：

```ts
{
  name: "ask_question",
  description:
    "Ask the user structured questions and wait for answers. Questions are select (options) or text. Returns {answers:[{id,selectedValues,freeText}]}. Blocks until the user answers in the product UI.",
  inputSchema: {
    type: "object",
    properties: {
      questions: { type: "array", items: { type: "object" } },
      identity: identitySchema, // CLI 后端经 arg 传 identity(与历史工具一致)
    },
    required: ["questions"],
  },
  entrypoint,
}
```

`mcp.ts` 的 `ListToolsRequestSchema` 同步注册；`service.ts` 的 `call()` switch 增加 `case "ask_question"`。

### ask 的状态：进程内 parked resolver（不新增表）

比照 approval（`pendingApprovalsByRun` 是纯内存），**不建新 DB 表**。ask 的生命周期与 run 同时存在（run 存活才能问，web 答题后立即返回给模型），进程重启即 run 已终态，无需持久化待答。

- service 增加内存结构：

```ts
// keyed `${runId}:${callId}` —— 与 approval 的 callId 语义一致
const pendingAsks = new Map<string, (answer: AskQuestionResult | null) => void>();
```

- `ask_question(input)` 流程：校验 input → 用 `input.signal`/一个超时包装 → 把 resolver 放进 `pendingAsks` → 调 `emitAsk(runId, callId, questions)`（让应用层发 SSE）→ `await` 一个有 `resolveAsk` 和超时两者都能 settle 的 Promise → 返回 `{content: JSON.stringify(answers)}`。
- 超时：`ASK_TIMEOUT_MS`（沿用 approval 的 deadline-deny 思路，默认 60s），超时 → resolve(null) → 返回 `{"error":"ask timeout"}`，模型端据此走降级（与现状 fail-closed 行为兼容）。
- service 暴露 `resolveAsk(runId, callId, answer)`：查 `pendingAsks`，若有则 settle；若无（已超时/run 终态）返回幂等 no-op。

### 事件与 resolve 端点

- `mcp.ts` 的 `createProductToolsMcpServer` 增加可选 `onAskRequest` 回调（`(runId, callId, questions) => void`），`service.call` 的 ask 分支经它 emit。应用层（`bootstrap/features.ts`）注入：收到后经 workflow SSE 总线 emit `human_task_requested` 同构事件（或新 `ask_requested` 事件），把 runId/callId/questions 推到 web。
- 新 HTTP 端点 `POST /api/product-tools/ask/resolve`（body `{runId, callId, answer}`）→ `productTools.resolveAsk(...)`。web 经 BFF 代理调用（与 `workflow-executions/human-tasks/batch-resolve` 同构，api.ts 加 `resolveProductAsk`）。
- endpoint 鉴权：与 product-tools 其他端点一致（run-token / 会话），见 ADR 0026 威胁模型。

### oma 原生 ask 与 MCP ask 的冲突规则

`run-runtime.ts` 已有裁决：若 workspace `.mcp.json` 注入了 `ask_question`（`hasInjectedAsk`），则不装 oma 原生工具（`run-runtime.ts:401-409`）。**注入 MCP ask 后 `hasInjectedAsk=true`，原生工具自动跳过，无需改 run-runtime 的装载逻辑**。`options.ask` 不再需要：MCP 工具的阻塞/唤醒全部在 backend 完成。

### Web：问卡复用 workflow 组件

- web 监听 SSE（沿用 workflow `human_task_requested` / `workflowExecutionEvents` 的 SSE 通道），命中 runId 的 ask → 弹出 **AskQuestionCard**（`apps/web/src/components/workflow/AskQuestionCard.tsx` 已存在，workflow human gate 用它）。
- 答题 → `resolveProductAsk(runId, callId, answers)`。
- 呈现位置：对话运行页 / 系统 run 详情。复用现有 `AskQuestionCard` 的 Select/Text 表单项与提交态。

### 边界与降级

- ask 只对**有注入 product-tools MCP 的运行**生效；缺 `.mcp.json` 或产品工具未合并的 standalone 运行 → 无 MCP ask → 保持现状（原生工具 fail-closed，模型自行决定）。
- CLI 后端（claude/pi/omp）经 `identity` arg 传 runId/callId（与 `todo_write`/`history_*` 一致，`mcp.ts` 已处理 `_meta` 缺失时的 arg-identity 回退）。
- 超时/run 中断 → ask 返回超时错误，模型走降级；不挂起 loop。

## 后果

- **backend**：`manifest.ts` + `mcp.ts`(ListTools) 加 `ask_question`；`service.ts` 加 `pendingAsks` map + `ask_question` case + `resolveAsk`；`bootstrap/features.ts` 注入 `onAskRequest` → SSE emit + 挂 `/api/product-tools/ask/resolve` 路由。
- **web**：`api.ts` 加 `resolveProductAsk`；run/对话页 SSE 监听 + 弹出 `AskQuestionCard`。
- **adapter / oma / claude / pi / omp**：**零改动**（全走共享 `adapter-mcp.callTool`）。
- **测试**：backend `service.test.ts`：ask 阻塞直到 resolve、重复 resolve 幂等、超时 deny、身份/清单校验失败；mcp.test.ts：ListTools 含 ask_question、CallTool 透传。
- **ADR 0026 威胁模型**：ask 是用户交互面，需确认端点鉴权与 run 作用域（沿用 product-tools 现有 assertScope / run-token）。
- 迁移：无 DB 迁移（不新增表）。
