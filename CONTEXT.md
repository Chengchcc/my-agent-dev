# CONTEXT.md — my-agent-team 项目心智模型

> 给 Agent 的项目记忆。每次进入仓库先读此文件。基于 2026-06-30 HEAD 现状撰写。
> 行为准则和仓库技术规范另见 [AGENTS.md](./AGENTS.md)。

## 领域语言（必背词汇）

| 词 | 含义 | 不是 |
|----|------|------|
| **Conversation** | 一场多方对话（人+Agent） | 不是 Run 容器 |
| **Message** | 对话轮次（`@my-agent-team/message`） | 不是 LedgerEntry（后者是存储 wrapper） |
| **MessageRevision** | 消息的版本化 envelope（同 messageId 多次写入，state 从 streaming→done） | 不是独立消息 |
| **Ledger（conversation_ledger）** | 对话可见内容的 canonical fact store | 不是执行日志 |
| **checkpoint_events** | 执行事实流（tool_start/tool_end/llm_call），按 sessionId+spanId 切 | 不是对话内容 |
| **Session（= trace）** | 「哪个 agent、在哪个上下文里、的那条持久记忆线」- persistence 主键 | 不是 span/run |
| **Span** | backend 的规范术语：session 上的一次 `prompt()` 调用（= root span）。DB 表 `span`、`spanId` 字段 | 不是 run（用户可见层的同义词，ADR 0007） |
| **Run** | Web UI 用户可见术语：一次 agent 执行。后端等价于 1 Span，但用户不需要知道 span 这个词 | 不是 Span（同义词，层不同，ADR 0007） |
| **attemptSeq** | span 内的重试序号，span 内单调递增 | 不是独立 id |
| **Plugin** | 贡献 tools + hooks 的可组合单元，hook 在注册序执行 | 不是 middleware |
| **ContextPipeline** | 管道式消息裁剪/摘要/预算，`pipeContextManagers(...)` 链式组合（运行时内部名 ContextManager） | 不是 Plugin |
| **persistence ports** | session 持久化拆分三端口：MessageStore（消息快照）+ InterruptStore（中断状态）+ EventLog（执行事实流） | 不是对话历史库 |
| **InterruptSignal** | 工具抛出的暂停信号，需 `resume({ approved })` 继续 | 不是错误 |
| **Compaction** | 旧消息摘要压缩，保留最近 N 条 + 摘要前缀 | 不是普通 summarize |
| **Agent** | Agent 生命周期编排（packages/agent） | 不是 backend service |
| **ConversationLock** | 会话级并发闸门，统一 HTTP 直发和 @ 触发两条路径 | 不是 thread busy |
| **Skill** | 一个命名的指令集（一个 `SKILL.md`），模型通过 `skill_load` 按需加载 | 不是 Plugin（后者是代码；Skill 是 markdown 内容） |
| **Skill Pack** | 一个技能集合的分发单元：有来源（git/zip/builtin）、版本、安装生命周期，物化为一个目录 | 不是 Skill Root（root 是它的运行时物化产物） |
| **Skill Root** | progressive-skill 扫描的目录路径；一个 Pack 贡献一个 Root | 不是 Pack 本体（Pack 是管理实体，Root 是它的磁盘投影） |
| **CronJob** | 一条按时间表反复触发的定时规则；通过 `loop_config_path` 引用 Loop 配置目录，到点调 `loopStep()` | 不是 Loop 本身（调度者 ≠ 被调度者） |
| **spanLoop** | agent runtime `span-loop.ts` 导出函数：单个 Span 内的 step 迭代（调模型->工具执行->循环直到 terminal）。纯实现机制 | 不是 Loop（多 Span 编排系统）；旧名 `runLoop`（已按 ADR 0007 改名） |
| **MCP Server（配置实体）** | 一个外部工具源的配置记录：transport（stdio/SSE）、command+args+env 或 url、enabled 状态。per-agent 绑定 | 不是 MCP Client（client 是运行时连接管理器） |
| **MCP Client** | 进程内常驻的 MCP 连接管理器：按 agentId 缓存连接 + discovery 结果，session 创建时同步读缓存拼 Tool[] | 不是 MCP Server（server 是配置实体；client 是运行时） |
| **MCP Tool** | 从外部 MCP server 发现的工具，适配为 `Tool` 接口后注入 agent。名字格式 `mcp__{serverName}__{toolName}` | 不是内置 Tool（后者是进程内函数；MCP Tool 的 execute 是一次 RPC） |


## 架构分层（6 层，自底向上）

```
L4 Agent        packages/agent — Agent lifecycle + Plugin system + persistence + context pipeline
L3 Runtime      packages/core — run() async generator
L2 Message      packages/message — Message/ChatModel types
L1 Contracts    packages/message — ContentBlock, Tool contract
```

## 包地图与进出口

| 包 | 层级 | 关键导出 |
|----|------|----------|
| `@my-agent-team/core` | L1+L2 | `Message`, `ChatModel`, `Tool`, `run()`, `collectStream()` |
| `@my-agent-team/message` | L1 | `Message`, `MessageRevision`, `ContentBlock`, `MessageAuthor`, `assistantMessageId()` |
| `@my-agent-team/conversation` | L1 | `LedgerEntry`, `LedgerKind`, `Member`, `Conversation`, `TriggerMode` |
| `@my-agent-team/agent` | L4 | Agent runtime, definePlugin(), session management, persistence, context pipeline |
| `@my-agent-team/loop` | L4 | `loopReducer()` — Item step 状态转移纯函数, `LoopState`, `LoopAction` 类型 |
| `@my-agent-team/api-contract` | 跨层 | Elysia `App` 类型真源（HTTP/SSE 契约），`SSEEventMap` |
| `@my-agent-team/config` | 跨层 | `envSchema` + `parseEnv()` — 环境变量单源 |
| `@my-agent-team/ai` | adapter | `Provider`, `Model`, `ModelRegistry`, `AnthropicChatModel` - 全仓唯一 import 模型 SDK 的地方 |
| `@my-agent-team/tools-common` | tools | bash/grep/glob/edit/write/read/web 工具工厂 |
| `@my-agent-team/test-helpers` | test | `echoModel()` — 确定性 ChatModel 测试替身 |

## 三条铁律（设计哲学核心）

1. **统一本体，不复制语义** — 同一领域对象（Message, Run, Conversation）不在每个模块各定义一份
2. **暴露业务，隐藏机制** — Ledger/EventLog/Projection/Checkpoint 是实现细节，不上浮成主心智
3. **边界要硬，概念要少** - 业务边界 6 个（Conversation / Run / Message / Agent / CronJob / Loop），机制边界可以多但必须低调
## 编码规则（每次改代码前必查）

### 跨进程契约（e2e-contract-rules.md）
- HTTP 请求/响应类型：backend Elysia `App` → `@my-agent-team/api-contract` → web 通过 `treaty<App>` 推导。**禁止**手抄 interface、`apiFetch<T>`、`as`
- SSE 事件：`SSEEventMap`（zod schema map）→ 后端 `sseEncoder`、前端 `typedSource`。**禁止**裸 `EventSource` + `JSON.parse` + `as`
- 环境变量：共享 `envSchema` + `parseEnv()`。**禁止**各进程裸读 `process.env`
- react-query：`queryOptions(params)` 单源，组件只调 `useXxx`。**禁止**组件内联 `queryKey`/`queryFn`

### Backend 内部类型链（db-typesafe-rules.md）
- drizzle 表定义（`schema.ts`）是**唯一真源**
- 读类型：`$inferSelect` → `Pick`/`Omit`。**禁止**手写 `interface XxxRow`
- 运行时校验：`xxxSelectSchema.parse(row)`。**禁止** `row as XxxRow`
- JSON 列：drizzle-zod transform（`JSON.parse`/`JSON.stringify`）。**禁止**业务层 `JSON.parse(row.x) as T`
- int bool 列：drizzle-zod transform。**禁止**业务层 `!!row.enabled`
- 数据流向单向：`schema.ts → types.ts → service.ts → http.ts`。反向依赖违规

### 通用
- **禁止 deep import**：跨包 import 必须走 package 的 `index.ts` barrel
- **禁止 Co-Authored-By** trailer
- **测试**：`bun:test`，`*.test.ts` 与源文件同目录，用 `echoModel()` 或内联 `ChatModel` 做确定性测试

## 关键数据流

```
人发消息 → POST → appendLedgerEntry (conversation_ledger) → broadcastMessage
         -> 触发判定 (mention/all) -> startAgentRun -> Agent.prompt(input)
         → runLoop: 模型流 → tool 执行 → 循环
         → onEvent("message") → appendAssistantMessage 直写 ledger (streaming)
         → 同 messageId 多次写入 → terminal revision (agent_end, state=done)
         → checkpoint_events 写入执行事实流 (按 spanId)
         → SSE push 到端 → UI 按 messageId upsert
```

## 关键不变量

1. conversation_ledger 是对话消息的唯一 canonical store
2. checkpoint_events 只含执行 detail，不含对话内容
3. Message 领域类型只在 `@my-agent-team/message` 定义
4. assistant 消息与人类消息经同一入口 `appendLedgerEntry` 写账本
5. 端（Web/飞书）可展示，不可成为事实来源
6. streaming revision 和 terminal revision 共享同一 messageId，端按 messageId collapse
7. ChatModel 是唯一外部集成点，core 无 LLM 依赖
8. 依赖只能向下：`core` -> `agent` -> `backend`，不可反向

## 当前技术债务（已知概念债）

| 债项 | 现状 | 目标 |
|------|------|------|
| threadId 未正名 | ✅ `threadId`→`sessionId` 全仓重命名（~50 处，26 文件） | 已完成 |
| run/span 混用 | ✅ ADR 0007 已定。代码 `runLoop`→`spanLoop`，DB 表 `run`→`span` | 已完成 |
| Agent per-span 创建 | ✅ `session-registry.ts` 已删除，`SessionFactory` 按 `sessionId` 索引，跨 span 持久 | 已完成 |
| spanId 不透传到 agent | ✅ `prompt/continue/resume` 已透传 `opts.spanId` 到 `agent.run()` | 已完成 |
| attempt 独立 id | ✅ `att-${runId}` 已删除，改为 `attemptSeq`（span 内整数序号） | 已完成 |
| 执行事实流未完全回归 ckp | ✅ `event_log` 表已删除，`appendEvent/readEvents` 是 EventLog 一等接口 | 已完成 |
## 常用命令

```bash
bun install          # 安装依赖
bun run format       # Biome format
bun run lint         # Biome check + ESLint
bun run typecheck    # tsc --noEmit (turbo)
bun run test         # 全量测试 (turbo)
bun run build        # tsc → dist/ (turbo)
bun run dev          # 启动 backend + web
```

单包测试：`cd packages/agent && bun test`
单文件/模式：`cd packages/agent && bun test --test-name-pattern="createAgent"`

## 工具链

- **Runtime**: Bun 1.3.14
- **TypeScript**: 6.0.3, ESM + NodeNext, target ES2023, strict + noUncheckedIndexedAccess
- **Monorepo**: Turborepo 2.x, workspaces: `apps/*`, `packages/*`
- **Format/Lint**: Biome 2.x + ESLint 10.x
- **DB**: SQLite (backend.db + checkpointer.db), drizzle-orm + drizzle-kit
- **HTTP**: Elysia (backend), treaty (web 类型安全客户端)
- **Commit**: commitlint + husky（见下方 §提交规范）
- **Test**: bun:test

## 提交规范（commitlint 必过项）

**格式**：`type(scope): subject` — scope **必填**，不可为空。

| 规则 | 值 |
|------|-----|
| 可用 type | `feat` `fix` `refactor` `perf` `style` `test` `docs` `chore` `ci` `revert` |
| 可用 scope（包） | `core` `message` `api-contract` `config` `conversation` `agent` `ai` `loop` `adapter-mcp` `agent-fs` `tools-common` `runner-protocol` `runner-daemon` `runtime-observability` `test-helpers` |
| 可用 scope（插件） | `plugin-fs-memory` `plugin-identity` `plugin-progressive-skill` `plugin-task-guard` `plugin-conversation-context` |
| 可用 scope（应用） | `backend` `web` `lark-bot` |
| 可用 scope（功能） | `cron` |
| 可用 scope（元） | `docs` `test` `lint` `build` `deps` `repo` |
| subject 最大长度 | 100 字符 |
| 禁止中文 | CJK 字符检测（commitlint-plugin-no-cjk） |
| body 前空行 | 必填（`body-leading-blank`） |

**Git Hook 链**：
```
pre-commit  → biome format --write + biome check --fix
commit-msg  → commitlint --edit
pre-push    → bun run lint
```

## CI 流程（GitHub Actions）

触发条件：PR 或 push 到 `master`/`main`。

```
checkout → setup Bun 1.3.14 → install deps → gen drizzle
  → lint → build → typecheck → test → verify dist fresh
```

最后一步校验所有 `packages/*/dist/` 和 `apps/*/dist/`（或 `.next/`）的新鲜度——任何源文件比构建产物新即标红。

## 文档导航

- 给人读：`docs/architecture/README.md` → 系统总览 → 按路线选读
- 给 LLM 读：`docs/architecture/index.llm.md` — 按问题类型路由到具体页面
- 概念图谱：`docs/architecture/concepts.json` — 机器可读依赖图
- 架构设计哲学：`docs/architecture/design-philosophy.md` — 每次设计/评审/修复前必读
- 跨进程契约规则：`docs/architecture/e2e-contract-rules.md` — 加字段/调接口前必查
- DB 类型安全规则：`docs/architecture/db-typesafe-rules.md` — 改表/加列前必查
- 标识符体系：`docs/architecture/foundations/identifiers.md` — id 归属与收敛方向
- 事实与投影：`docs/architecture/foundations/facts-and-projections.md` — 两类事实的边界
