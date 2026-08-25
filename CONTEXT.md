# CONTEXT.md — my-agent-team 项目心智模型

> 给 Agent 的项目记忆。每次进入仓库先读此文件。基于 2026-08-05（Phase 6）HEAD 现状撰写。
> 行为准则和仓库技术规范另见 [AGENTS.md](./AGENTS.md)。

## 领域语言（必背词汇）

| 词 | 含义 | 不是 |
|----|------|------|
| **Conversation** | 一场 1:1 对话（人 + 唯一 agent，`conversation.agent_id` 绑定） | 不是 Run 容器，不是多方房间（member 概念已删） |
| **Message** | 对话轮次（`@chengchenccc/message`） | 不是 LedgerEntry（后者是存储 wrapper） |
| **MessageRevision** | 消息的版本化 envelope（同 messageId 多次写入，state 从 streaming→done） | 不是独立消息 |
| **ConversationEvent** | SSE wire 载荷（`{seq, kind, message?, payload?, undone?}`，服务端已 parse） | 不是 LedgerEntry（存储行不出 backend） |
| **Ledger（conversation_ledger）** | 对话可见内容的 canonical fact store；final assistant Message 带 `agent_run_id` 提交标记 | 不是执行日志 |
| **Agent Context** | 每个 conversation 的语义历史（tree/entry/branch；1:1 后 tree 单键） | 不是 child transcript |
| **CLI Session** | CLI 后端(claude/pi/omp)的运行态会话真理:claude `session_id` / pi·omp 会话文件路径;分支经 `cliSessionRef` 引用 | 不是 Context Branch(后者是产品态历史,可 fork/rollback;CLI session 不可回滚) |
| **Agent Workspace** | 每个 agent 的可配置运行工作区(绝对路径):`agent.yml` 为唯一真源(identity + runtime_config + lark)、AGENTS.md/CLAUDE.md/SOUL.md/USER.md、knowledge/、`.<kind>/` 配置目录 | 不是 dataDir 里的固定物化目录 |
| **Workspace Bridge** | 把 dataDir 单点资源(skill/knowledge/mcp)按 agent 分配**桥接**到 workspace 的幂等 reconcile(软链 skills、写 `.mcp.json`) | 不是每种资源一套拷贝逻辑 |
| **Agent Run** | branch 上的持久产品执行；**唯一执行身份**（agent_run 表） | 不是 span/attempt/session（已删除） |
| **branch_input_queue** | normal/steer/follow_up 输入的持久队列；每行携带 request-time 配置快照 | 不是内存队列 |
| **BackendRunOutcome** | child 的唯一终态结果：completed/failed/aborted/timeout | 不是事件流（事件永不决定终态） |
| **Product Tool** | History 读写、审批等产品能力，由 Product Backend 统一执行（幂等 + 审计） | 不是 native tool（child 自己的文件/Shell 工具） |
| **Oma** | 无 UI 的一次性 CLI（print/json/rpc），被 Adapter 按 Run spawn | 不是 daemon（无常驻进程） |
| **Adapter（agent-backend）** | spawn child、stdin/stdout JSONL、steer/abort、并发上限、event/outcome 映射 | 不是执行引擎 |
| **Plugin** | 贡献 tools + hooks 的可组合单元（packages/agent）；当前真实插件：todo、progressive-skill | 不是 middleware |
| **Compaction** | child 内 Run-local 摘要压缩，只影响本次 Run 输入 | 不是 Product Summary（后者是 Agent Context entry） |
| **Skill Pack** | 技能集合的分发单元（git/zip/builtin），物化为目录；Run 冻结 skillRoots | 不是 Skill Root（root 是运行时物化产物） |
| **CronJob** | 按时间表触发的定时规则；到点创建 Agent Run（或调 `loopStep()`） | 不是 Loop 本身 |
| **Loop** | 文件态工作系统：STATE.md 状态机 + Generator/Evaluator Agent Runs + VERDICT.md | 不是 Run（Run 是单次执行） |
| **MCP Server（配置实体）** | 外部工具源配置记录；Product Tools MCP 是 child 调用产品能力的接入方式 | 不是 MCP Client |

## 唯一执行链

```text
Product Backend
→ durable Agent Run
→ full Product Context projection
→ Agent Backend (按 backendKind 选: adapter-oma-agent / adapter-claude-agent / adapter-pi-agent / adapter-omp-agent)
→ spawn one-shot oma child (--mode rpc, stdin/stdout JSONL)
→ per-Run Oma Runtime (packages/agent)
→ BackendRunOutcome
→ atomic Product terminal commit
```

**核心所有权：**

- **Product Backend 拥有**：Conversation History、Agent Context/Branch、Agent Run、输入队列、Product Tools、Agent 身份/配置、final assistant Message、terminal commit。
- **Oma 拥有**（子进程内，每 Run 新建）：model/tool loop、native tools、retry、compaction、Run-local todo、progressive skill 加载、print/json/rpc 模式。
- **Adapter 拥有**：spawn child、JSONL、steer/abort、child 并发上限、stderr 尾部/脱敏、event/outcome 映射、child recycle。

## 架构分层

```text
L5 Surfaces     Web / Lark — HTTP/SSE
L4 Backend      Product Backend（Elysia）：账本、Agent Context、Agent Run、Loop、Product Tools
L3 Adapter      packages/adapter-* — child 进程边界（spawn/JSONL/steer/abort）
L2 Runtime      packages/agent — Oma 唯一真实 model/tool loop（agent-loop.ts）
L1 Contracts    packages/message、packages/core、packages/agent-backend — 类型/协议
```

## 包地图与进出口

| 包 | 层级 | 关键导出 |
|----|------|----------|
| `@chengchenccc/core` | L1 | `ChatModel`, `Tool`, `AIMessageChunk`, `ContentBlock`, `collectStream`（无 run loop） |
| `@chengchenccc/message` | L1 | `Message`, `MessageRevision`, `ContentBlock`, `assistantMessageId(runId, ordinal)` → `run:<runId>:assistant:<n>` |
| `@chengchenccc/agent-backend` | L1 | `AgentBackend`, `BackendRunInput/Outcome/Segment`, `BackendEvent`, `BackendKind`, `BackendModelRef`（backend 中立契约；不含任何 child wire 协议） |
| `@chengchenccc/agent` | L2 | Oma Runtime：`createOmaSession()`, plugin.ts, in-memory SessionStore, compaction, todo |
| `@chengchenccc/adapter-oma-agent` | L3 | `OmaBackend` — spawn/JSONL/steer/abort/concurrency |
| `@chengchenccc/adapter-omp-agent` | L3 | `OmpBackend` — `omp -p --mode json` 每 turn 短进程;分支钉 session 文件续接 |
| `@chengchenccc/adapter-pi-agent` | L3 | `PiBackend` — `pi -p --mode json`;`--session` 写+续;pi-mcp-adapter 挂产品工具 |
| `@chengchenccc/adapter-claude-agent` | L3 | `ClaudeBackend` — stream-json per-turn + `--resume`;result.modelUsage 提取 |
| `@chengchenccc/loop` | L2 | `loopReducer()` 纯函数, `LoopState`, `LoopAction` |
| `@chengchenccc/api-contract` | 跨层 | Elysia `App` 类型真源（HTTP/SSE 契约），`SSEEventMap` |
| `@chengchenccc/ai` | adapter | `Provider`, `Model`, `ModelRegistry`, `createModelRuntime`, `AnthropicChatModel` |
| `@chengchenccc/tools-common` | tools | bash/grep/glob/edit/write/read/web 工具工厂 |
| `apps/oh-my-agent/src/core/todo.ts` / `skill.ts` | oma-native | todo / progressive-skill（已从独立 plugin 包吸收，后续对齐 Claude plugin marketplace） |
| TUI focus-resume recap | oma TUI | terminal regain focus 后展示上次结果摘要；recap_update 事件已删除 |
| `@chengchenccc/test-helpers` | test | `echoModel()` 确定性 ChatModel 测试替身 |

## 三条铁律（设计哲学核心）

1. **统一本体，不复制语义** — 同一领域对象（Message, Run, Conversation）不在每个模块各定义一份
2. **暴露业务，隐藏机制** — Ledger/Queue/Projection 是实现细节，不上浮成主心智
3. **边界要硬，概念要少** — 业务边界：Conversation / Agent Run / Message / Agent / CronJob / Loop；执行只有一个：child process

## 编码规则（每次改代码前必查）

### 跨进程契约（e2e-contract-rules.md）
- HTTP 请求/响应类型：backend Elysia `App` → `@chengchenccc/api-contract` → web 通过 `treaty<App>` 推导。**禁止**手抄 interface、`apiFetch<T>`、`as`
- SSE 事件：`SSEEventMap`（zod schema map）→ 后端 `sseEncoder`、前端 `typedSource`。**禁止**裸 `EventSource` + `JSON.parse` + `as`
- Agent Backend 中立契约：`@chengchenccc/agent-backend` 是唯一真源。**禁止** adapter/backend 各写一套。
- Oma wire 协议：`apps/oh-my-agent` 内部闭环，fixture 是契约；`apps/oh-my-agent` 生成 canonical `rpc-*.jsonl`，`packages/adapter-oma-agent` 测试消费。**禁止**共享 wire-schema 包。
- react-query：`queryOptions(params)` 单源，组件只调 `useXxx`。**禁止**组件内联 `queryKey`/`queryFn`

### Backend 内部类型链（db-typesafe-rules.md）
- drizzle 表定义（`schema.ts`）是**唯一真源**
- 读类型：`$inferSelect` → `Pick`/`Omit`。**禁止**手写 `interface XxxRow`
- 运行时校验：`xxxSelectSchema.parse(row)`。**禁止** `row as XxxRow`
- 数据流向单向：`schema.ts → types.ts → service.ts → http.ts`。反向依赖违规

### 通用
- **禁止 deep import**：跨包 import 必须走 package 的 `index.ts` barrel
- **禁止 Co-Authored-By** trailer
- **测试**：`bun:test`，`*.test.ts` 与源文件同目录，用 `echoModel()` 或内联 `ChatModel` 做确定性测试

## 关键数据流

```text
人发消息 → POST（身份/路由服务端推导）→ appendLedgerEntry (conversation_ledger)
         → 触发 conversation 的唯一 agent → 创建 Agent Run（冻结 systemPrompt/skillRoots）
         → Adapter spawn oma --mode rpc → execute command
         → child 事件 → Live Updates → SSE push 到端 → UI 按 messageId upsert
         → outcome envelope → BackendRunOutcome
         → terminal commit：final assistant Message（agent_run_id）+ Context ref + branch + Run 终态（同一事务）
         → child 自行退出
```

## 关键不变量

1. conversation_ledger 是对话消息的唯一 canonical store
2. Agent Run 是唯一执行身份；无 span/attempt/session（Phase 6 已删表删列）
3. Message 领域类型只在 `@chengchenccc/message` 定义
4. assistant 消息与人类消息经同一入口 `appendLedgerEntry` 写账本
5. 端（Web/飞书）可展示，不可成为事实来源
6. streaming revision 和 terminal revision 共享同一 messageId（`run:<runId>:assistant:0`），端按 messageId collapse
7. BackendRunOutcome 是终态唯一依据；事件流永不决定终态
8. 同一 Context Branch 最多一个 active Agent Run
9. 每个 Run 以产品投影为输入;oma 是全量投影重建,CLI backends(claude/pi/omp)的上下文续接依赖 CLI 自身 session(`cliSessionRef`)——双轨真理,见 ADR 0019;CLI session 不可回滚,重放=以最新输入重开 turn
10. 依赖只能向下：`core` -> `message`/`agent` -> `backend`，不可反向

## 常用命令

```bash
bun install          # 安装依赖
bun run format       # Biome format
bun run lint         # Biome check + ESLint
bun run typecheck    # tsc --noEmit (turbo)
bun run test         # 全量测试 (turbo)
bun run build        # tsc → dist/ (turbo)
bun run dev          # 启动 backend + web
cd apps/backend && bun run db:check:backend   # drizzle schema/migration 校验
```

单包测试：`cd packages/agent && bun test`
集成测试：`bun test apps/backend/tests/integration/agent-run-oma.test.ts`（真实 child）

## 工具链

- **Runtime**: Bun 1.3.14
- **TypeScript**: 6.0.3, ESM + NodeNext, target ES2023, strict + noUncheckedIndexedAccess
- **Monorepo**: Turborepo 2.x, workspaces: `apps/*`, `packages/*`
- **Format/Lint**: Biome 2.x + ESLint 10.x
- **DB**: SQLite（backend.db 单文件），drizzle-orm + drizzle-kit（migrations 在 `apps/backend/drizzle/backend`）
- **HTTP**: Elysia (backend), treaty (web 类型安全客户端)
- **Commit**: commitlint + husky（见下方 §提交规范）
- **Test**: bun:test

## 提交规范（commitlint 必过项）

**格式**：`type(scope): subject` — scope **必填**，不可为空。scope 枚举以 `commitlint.config.mjs` 为准（Phase 6 后已收敛：`core` `message` `agent` `agent-backend` `adapter-oma-agent` `oma` `conversation` `api-contract` `ai` `loop` `tools-common` `plugin-*` `backend` `web` `lark-bot` `cron` `mcp` `settings` `docs` `test` `lint` `build` `deps` `repo`）。

| 规则 | 值 |
|------|-----|
| 可用 type | `feat` `fix` `refactor` `perf` `style` `test` `docs` `chore` `ci` `revert` |
| subject 最大长度 | 100 字符 |
| 禁止中文 | CJK 字符检测（commitlint-plugin-no-cjk） |
| body 前空行 | 必填（`body-leading-blank`） |

**Git Hook 链**：
```
pre-commit  → biome format --write + biome check --fix
commit-msg  → commitlint --edit
pre-push    → bun run lint
```

## 文档导航

- 给人读：`docs/architecture/README.md` → 系统总览 → 按路线选读
- 给 LLM 读：`docs/architecture/index.llm.md` — 按问题类型路由到具体页面
- 概念图谱：`docs/architecture/concepts.json` — 机器可读依赖图
- 架构设计哲学：`docs/architecture/design-philosophy.md` — 每次设计/评审/修复前必读
- 跨进程契约规则：`docs/architecture/e2e-contract-rules.md` — 加字段/调接口前必查
- DB 类型安全规则：`docs/architecture/db-typesafe-rules.md` — 改表/加列前必查
- 标识符体系：`docs/architecture/foundations/identifiers.md` — runId 唯一执行身份
- 事实与投影：`docs/architecture/foundations/facts-and-projections.md` — 两类事实的边界
- Tombstones（历史概念，勿引用）：`runtime/framework.md`、`runtime/context-manager.md`、`runtime/plugin.md`、`harness/harness.md`、`backend/event-log.md`
