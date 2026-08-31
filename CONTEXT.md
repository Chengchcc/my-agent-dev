# CONTEXT.md — my-agent-team 项目心智模型

> 给 Agent 的项目记忆。每次进入仓库先读此文件。基于 2026-08-31 HEAD 撰写
> （上一版基线 2026-08-05/Phase 6，其间 532 commits：oma 插件系统 + HITL、
> Product Tools MCP 化（token-per-run）、Loop 删除与 Workflow DSL/Artifact/Sandbox 落地）。
> 行为准则和仓库技术规范另见 [AGENTS.md](./AGENTS.md)。
> AGENTS.md / README / knowledge-packs 的目录与包清单已于 2026-08-31 与本文件对齐。

## 一句话

团队级 Agent 运行时：每个 Agent 一个文件即配置的工作区，运行时可在 oma（自研）/
claude / pi / omp 四后端间切换；对话在 Web + 飞书双端实时同步；自动化由声明式
Agentic Workflow（agent/script/human 节点图 + Artifact 传递 + cron 触发）承载。
Product Backend 按 Run 调度一次性 child 进程，账本唯一、终态原子、所有端一致。

## 领域语言（必背词汇）

| 词 | 含义 | 不是 |
|----|------|------|
| **Conversation** | 一场 1:1 对话（人 + 唯一 agent，`conversation.agent_id` 绑定） | 不是 Run 容器，不是多方房间（member 概念已删） |
| **Message** | 对话轮次（`@chengchenccc/message`） | 不是 LedgerEntry（后者是存储 wrapper） |
| **MessageRevision** | 消息的版本化 envelope（同 messageId 多次写入，state 从 streaming→done） | 不是独立消息 |
| **ConversationEvent** | SSE wire 载荷（`{seq, kind, message?, payload?, undone?}`，服务端已 parse） | 不是 LedgerEntry（存储行不出 backend） |
| **Ledger（conversation_ledger）** | 对话可见内容的 canonical fact store；final assistant Message 带 `agent_run_id` 提交标记 | 不是执行日志 |
| **Agent Context** | 每个 conversation 的语义历史（tree/entry/branch；1:1 后 tree 单键） | 不是 child transcript |
| **CLI Session** | CLI 后端(claude/pi/omp)的运行态会话真理：claude `session_id` / pi·omp 会话文件路径；分支经 `cliSessionRef` 引用 | 不是 Context Branch（后者可 fork/rollback；CLI session 不可回滚） |
| **Agent Workspace** | 每个 agent 的可配置运行工作区(绝对路径)：`agent.yml` 唯一真源(identity + runtime_config + lark)、AGENTS.md/CLAUDE.md/SOUL.md/USER.md、knowledge/、`.<kind>/` 配置目录 | 不是 dataDir 里的固定物化目录 |
| **Workspace Bridge** | 把 dataDir 单点资源(skill/knowledge/mcp)按 agent 分配**桥接**到 workspace 的幂等 reconcile（软链 skills、写 `.mcp.json`） | 不是每种资源一套拷贝逻辑 |
| **Agent Run** | branch 上的持久产品执行；**唯一执行身份**（agent_run 表） | 不是 span/attempt/session（已删除） |
| **branch_input_queue** | normal/steer/follow_up 输入的持久队列；每行携带 request-time 配置快照 | 不是内存队列 |
| **BackendRunOutcome** | child 的唯一终态结果：completed/failed/aborted/timeout | 不是事件流（事件永不决定终态） |
| **Oma** | 无 UI 的一次性 CLI（print/json/rpc + 交互 TUI），被 Adapter 按 Run spawn | 不是 daemon（无常驻进程） |
| **Adapter（agent-contract）** | spawn child、stdin/stdout JSONL、steer/abort/resolve_approval、并发上限、event/outcome 映射 | 不是执行引擎 |
| **Workflow** | 声明式节点图 DSL（`@chengchenccc/workflow` 纯域层）：start/end/agent/script/human 节点 + 带条件的边 + cron 触发；文件态 `*.workflow.json` | 不是 Loop（已删）、不是 oma 脚本式 workflow executor |
| **Workflow Execution** | 一次 workflow 运行的持久实例（execution/node_run/pending_human 三表；SSE live + replay；可 cancel） | 不是 Agent Run（agent 节点才创建 Agent Run） |
| **Node Run** | 单节点一次执行的行（输出、路由 routedTo、错误、关联 runId） | 不是 LedgerEntry |
| **Human Gate** | human 节点：execution 进 `waiting_human`，Web 渲染问卷表单，提交后续跑；取消即终态 | 不是 HITL Approval（后者是工具级） |
| **Artifact** | 带类型的产物（key-type 数组 schema 中的 `artifact` 类型；fs 存储 + MCP 工具 + REST；节点/run 依赖检查；聊天 @-mention 引用） | 不是聊天附件 |
| **Sandbox** | `@chengchenccc/sandbox` 进程隔离执行：spawn bun 子进程、临时 cwd、最小 env、硬超时、JSON stdio 契约 | 不是 fs/network jail（容器级隔离明确非目标，ADR 0026 边界内接受） |
| **HITL Approval** | 工具级审批链：child `approval_request` → adapter 透传 → backend SSE → Web Allow/Deny 卡片 → `POST /api/agent-runs/:runId/approval` → `resolve_approval` 命令；超时(`OMA_APPROVAL_TIMEOUT_MS`)fail-closed deny | 不是 Human Gate（节点级） |
| **Product Tool** | History/todo 等产品能力，由 backend 的 **Product Tools MCP server**(SSE) 统一执行（幂等 + 审计 `product_tool_call`）；经 workspace `.mcp.json` 注入 child | 不是 native tool；oma 侧**无 product 特化**（就是一个 MCP server） |
| **Run Token** | per-run 产品工具 bearer（dispatch 时铸造、SHA-256 键注册表、run settle 即 revoke）；`.mcp.json` 只含 env 名 + `${VAR}` 占位符，文件零密文 | 不是静态 service token（已删） |
| **Plugin** | oma 可组合单元（tools + hooks），`core/plugins/` 加载：native import 代码、sha256 信任记录、scope×mode 矩阵（RPC 永不加载 project-scope 代码） | 不是 middleware；不是 Product 概念 |
| **Marketplace** | oma 插件分发：多源 manifest（oma plugin.json → `.claude-plugin/plugin.json` → package.json omp/pi 字段，冲突矩阵），git 源记录 HEAD rev 为 version | 不是 backend 概念 |
| **Skill Pack** | 技能集合的分发单元（git/zip/builtin，经 `@chengchenccc/source-fetch` 物化）；Run 冻结 skillRoots；builtin 能力文档（workflow-authoring、agentic-workflow-dsl 等）永远可用 | 不是 Skill Root（root 是运行时物化产物） |
| **Knowledge Pack** | 知识库分发单元（ADR 0022），MCP 暴露；本仓库自食其力维护 `knowledge-packs/my-agent-team` | 不是 Skill Pack |
| **Project / Worktree** | 项目实体 + 每 agent 每 project 的 git worktree（ADR 0023）；`workspace-lock` per-worktree 互斥（run dispatch / clean-start / agent detach 同锁序列化） | 不是 Agent Workspace |

## 两条执行链

```text
① 对话链
Product Backend
→ durable Agent Run（冻结 systemPrompt/skillRoots/permissionMode/workspace/model）
→ full Product Context projection
→ Agent Backend (按 backendKind 选: adapter-oma-agent / adapter-claude-agent / adapter-pi-agent / adapter-omp-agent)
→ spawn one-shot child (oma: --mode rpc, stdin/stdout JSONL；CLI 后端: 每 turn 短进程 + 原生 session 续接)
→ BackendRunOutcome
→ atomic Product terminal commit

② Workflow 链（自动化）
cron 到点(Bun.cron trigger-scheduler) / 手动 / 模板实例化
→ WorkflowExecution（定义来自 dataDir `workflows/*.workflow.json`）
→ computeNext 纯引擎逐步推进（路由在节点完成时冻结进 routedTo，永不重算；join = any-of）
→ agent 节点 = dispatch Agent Run（outputSchema 约束 + harness 级 schema retry）
→ script 节点 = runInSandbox（进程沙箱）
→ human 节点 = waiting_human + Web 表单
→ end → exit status；产物经 Artifact 沉淀
```

**核心所有权：**

- **Product Backend 拥有**：Conversation History、Agent Context/Branch、Agent Run、输入队列、Product Tools MCP + Run Token、Workflow 定义/执行/节点/human 表单、Artifact 元数据、Agent 身份/配置、final assistant Message、terminal commit。
- **Oma 拥有**（子进程内，每 Run 新建）：model/tool loop、native tools、retry、compaction、Run-local todo、progressive skill 加载、插件加载与信任、print/json/rpc/TUI 模式、脚本式 workflow executor（`BackendRunInput.workflow` 输入，ADR 0025）。
- **Adapter 拥有**：spawn child、JSONL、steer/abort/resolve_approval、child 并发上限、stderr 尾部/脱敏、event/outcome 映射、child recycle。
- **Workflow 引擎拥有**：图推进纯函数（`@chengchenccc/workflow`，无 I/O）；节点执行复用 Agent Run 与 sandbox，不自建执行器。

## 架构分层

```text
L5 Surfaces     Web / Lark — HTTP/SSE
L4 Backend      Product Backend（Elysia）：账本、Agent Context、Agent Run、Workflow、Artifact、Product Tools MCP、workspace bridge
L3 Adapter      packages/adapter-* — child 进程边界（spawn/JSONL/steer/abort/approval）
L2 Runtime      apps/oh-my-agent/src/core — Oma 唯一真实 model/tool loop（agent-loop.ts）+ 插件 + workflow executor
L1 Contracts    packages/message（协议）、packages/agent-contract（spawn 中立契约）、packages/workflow（DSL 纯域）
```

## 包地图与进出口

| 包 | 层级 | 关键导出 |
|----|------|----------|
| `@chengchenccc/message` | L1 | Message 本体 + ChatModel/Tool/AIMessageChunk/stream-utils 协议 |
| `@chengchenccc/agent-contract` | L1 | `AgentBackend`, `BackendRunInput/Outcome/Segment`, `BackendEvent`, `BackendKind`, `BackendModelRef`（4 个 adapter 实现） |
| `@chengchenccc/workflow` | L1 | 纯域：`WorkflowDefinition`（节点/边/触发器）、`computeNext` 引擎、JSON-Logic、schema 子集校验、`parseWorkflow` |
| `@chengchenccc/adapter-oma-agent` | L3 | `OmaBackend` — spawn/JSONL/steer/abort/resolve_approval/concurrency |
| `@chengchenccc/adapter-claude-agent` / `-pi-` / `-omp-` | L3 | CLI 后端 adapter（stream-json / `--session` / `-p --mode json`；原生 session 续接） |
| `@chengchenccc/adapter-mcp` | L3 | MCP client adapter — 外部 server 接入，工具适配到 Tool 接口 |
| `@chengchenccc/api-contract` | 跨层 | Elysia `App` 类型真源（HTTP/SSE 契约），`SSEEventMap` |
| `@chengchenccc/ai` | adapter | Provider/Model/ModelRegistry/`createModelRuntime`；三协议（anthropic-messages / openai-completions / openai-responses）+ compat registry + `~/.oma/models.yml` |
| `@chengchenccc/sandbox` | 基座 | `runInSandbox` — 进程隔离脚本执行（JSON stdio 契约） |
| `@chengchenccc/source-fetch` | 基座 | `fetchGitSource(Sync)` / `materializeZipSource`（解压前 zip 条目守卫）/ `directoryFingerprint`；oma marketplace 与 backend skill-pack 共用，互不 import |
| `@chengchenccc/tui` | oma 支撑 | 终端 UI 工具箱（editor/keys/markdown 渲染/mermaid-ascii/autocomplete/virtual terminal） |
| `apps/oh-my-agent/src/core/` | oma-native | `createOmaSession()`、agent-loop、plugins（code/trust/resolve/marketplace）、compaction、persistence、session、autonomous-memory 文件读取 |
| `apps/oh-my-agent/src/core/tools/` | oma-native | bash/grep/glob/edit/write/read/web/ask-question/eval（eval 走 sandbox）工具工厂、mcp-mount（workspace/user/project 多源合并 + `${CLAUDE_PLUGIN_ROOT}`） |
| `apps/oh-my-agent/src/core/workflow/` | oma-native | 脚本式 workflow executor + subagent registry（Run.workflow 输入路径） |
| `@chengchenccc/test-helpers` | test | `echoModel()` 确定性 ChatModel 测试替身 |

## 三条铁律（设计哲学核心）

1. **统一本体，不复制语义** — 同一领域对象（Message, Run, Conversation, Workflow）不在每个模块各定义一份
2. **暴露业务，隐藏机制** — Ledger/Queue/Projection/Engine 是实现细节，不上浮成主心智
3. **边界要硬，概念要少** — 执行只有一个：child process；工具只有一个面：MCP/native PluginTool，无 product 特化

## 编码规则（每次改代码前必查）

### 跨进程契约（e2e-contract-rules.md）
- HTTP 请求/响应类型：backend Elysia `App` → `@chengchenccc/api-contract` → web `treaty<App>` 推导。**禁止**手抄 interface、`apiFetch<T>`、`as`
- SSE 事件：`SSEEventMap`（zod schema map）→ 后端 `sseEncoder`、前端 `typedSource`。**禁止**裸 `EventSource` + `JSON.parse` + `as`
- Agent Backend 中立契约：`@chengchenccc/agent-contract` 唯一真源。**禁止** adapter/backend 各写一套
- Oma wire 协议：`apps/oh-my-agent` 内部闭环，`rpc-*.jsonl` fixture 是契约（oma 生成、adapter 测试消费）。**禁止**共享 wire-schema 包
- react-query：`queryOptions(params)` 单源。**禁止**组件内联 `queryKey`/`queryFn`

### Backend 内部类型链（db-typesafe-rules.md）
- drizzle `schema.ts` 是**唯一真源**；读类型 `$inferSelect` → `Pick`/`Omit`。**禁止**手写 `interface XxxRow`
- 运行时校验 `xxxSelectSchema.parse(row)`。**禁止** `row as XxxRow`
- 数据流向单向：`schema.ts → types.ts → service.ts → http.ts`

### 通用
- **禁止 deep import**：跨包 import 走 package 的 `index.ts` barrel
- **禁止 Co-Authored-By** trailer
- 测试 `bun:test`，`*.test.ts` 与源同目录；模型用 `echoModel()` 或 scripted ChatModel；**测试里 pin agent 目录**
- Web BFF 路由显式 `/api/bff/api/` 前缀；run model（非 catalog[0]）绑定 budget+summarizer

## 关键数据流

```text
① 对话（人发消息）
人发消息 → POST（身份/路由服务端推导）→ appendLedgerEntry
→ 触发 conversation 唯一 agent → 创建 Agent Run（冻结配置快照）
→ dispatch: 铸 Run Token → workspace bridge 写 .mcp.json（env 名 + ${VAR}，零密文）
→ Adapter spawn child → execute → child 挂载 Product Tools MCP（SSE + bearer）
→ child 事件 → Live Updates → SSE push → UI 按 messageId upsert
→ outcome → BackendRunOutcome → terminal commit（final Message + Context ref + Run 终态，同一事务）→ token revoke → child 退出

② 工具级审批（HITL）
permissionMode=ask 的工具调用 → child approval_request 事件
→ adapter 透传（backend.oma.* 默认映射）→ backend SSE → Web Allow/Deny 卡片
→ POST /api/agent-runs/:runId/approval → adapter resolve_approval（id 匹配）
→ child 继续/中止；超时 = deny（fail-closed）

③ 工具注入优先级
mounted MCP 工具表（native + MCP + plugin 汇总）统一过滤（--tools 白/黑名单）
→ MCP 注入 todo_write 存在则 native todo 让位（注入优先于内置默认）
```

## 关键不变量

1. conversation_ledger 是对话消息的唯一 canonical store；assistant 与人类消息经同一入口 `appendLedgerEntry` 写入
2. Agent Run 是唯一执行身份；BackendRunOutcome 是终态唯一依据，事件流永不决定终态
3. Message 领域类型只在 `@chengchenccc/message` 定义；依赖只能向下
4. streaming revision 与 terminal revision 共享同一 messageId（`run:<runId>:assistant:0`），端按 messageId collapse
5. 同一 Context Branch 最多一个 active Agent Run；follow-up 输入用**自己的**快照升级为新 Run
6. CLI backends 上下文续接依赖 CLI 自身 session（`cliSessionRef`）——双轨真理（ADR 0019）；重放 = 以最新输入重开 turn
7. Workflow 引擎是纯函数；节点路由完成时冻结（`routedTo`），永不重算；join 语义 any-of（AND 需显式 DSL marker）
8. script 节点/oma eval 永远经 sandbox（进程边界，非 fs jail——接受面见 ADR 0026）
9. 产品工具凭证只经 env 传递；`.mcp.json` 零密文；Run Token settle 即 revoke
10. 子代理角色只能**收窄**工具集，不能放宽；模型覆盖必须在 catalog 内解析（ADR 0026）
11. 端（Web/飞书）可展示，不可成为事实来源

## 已知前沿与未决

- **ADR 0026 威胁模型**（单用户本地产品，agent 半信任）：LAN/hosted 前需补 — bash 约束超 cwd 检查、MCP env/headers 静态加密、移除 mock 登录面
- `docs/future-work.md`：native 工具 ask 范围目前仅覆盖插件 code 工具的补全（run-runtime 级 gate 已有）；plugin update 命令等小项
- `docs/architecture/roadmap/future-work.md` 自标"需复核"（2026-08-13/20 基线，Loop 条目已随 Loop 删除失效）——读时以 ADR 索引为准
- loop_item / loop_budget / cron_job 表仍在 schema（仅 Phase-6 db fixture 引用，无代码读者）——下次动 schema 可一并清列

## 常用命令

```bash
bun install          # 安装依赖
bun run format       # Biome format
bun run lint         # Biome check + ESLint
bun run typecheck    # tsc --noEmit (turbo)
bun run test         # 全量测试 (turbo)
bun run build        # tsc → dist/ (turbo)
bun run dev          # backend(3000) + web(3001)
cd apps/backend && bun run db:check:backend   # drizzle schema/migration 校验
```

单包测试：`cd apps/oh-my-agent && bun test`
集成测试（真实 child）：`bun test apps/backend/tests/integration/agent-run-oma.test.ts`

## 工具链

- **Runtime**: Bun 1.3.14；**TS**: 6.x, ESM + NodeNext, ES2023, strict + noUncheckedIndexedAccess
- **Monorepo**: Turborepo 2.x（workspaces: `apps/*`, `packages/*`）
- **Format/Lint**: Biome 2.x + ESLint；**DB**: SQLite 单文件 + drizzle（migrations 在 `apps/backend/drizzle/backend`）
- **HTTP**: Elysia (backend) + treaty (web)；**Test**: bun:test

## 提交规范（commitlint 必过项）

**格式**：`type(scope): subject` — scope **必填**。当前 scope 枚举（commitlint.config.mjs）：
`core` `message` `api-contract` `config` `agent-contract` `tui` `adapter-oma-agent` `adapter-omp-agent` `adapter-pi-agent` `adapter-claude-agent` `adapter-mcp` `ai` `backend` `oh-my-agent` `web` `lark-bot` `agent-run` `workflow` `sandbox` `mcp` `settings` `docs` `test` `lint` `build` `deps` `repo`
（历史提交里的 `agent`/`loop`/`cron`/`conversation` 等 scope 已不在枚举，勿再用）

| 规则 | 值 |
|------|-----|
| 可用 type | `feat` `fix` `refactor` `perf` `style` `test` `docs` `chore` `ci` `revert` |
| subject 最大长度 | 100 字符 |
| 禁止中文 | 全消息含 body（commitlint-plugin-no-cjk） |
| body 前空行 | 必填；body 每行 ≤100 字符 |

**Git Hook 链**：pre-commit → biome format+check；commit-msg → commitlint；pre-push → lint

## 文档导航

- 给人读：`docs/architecture/README.md` → 系统总览 → 按路线选读
- 给 LLM 读：`docs/architecture/index.llm.md`；概念图谱 `concepts.json`
- 设计哲学：`docs/architecture/design-philosophy.md` — 设计/评审前必读
- 契约规则：`e2e-contract-rules.md`（加字段/调接口前）、`db-typesafe-rules.md`（改表前）
- ADR 索引：`docs/adr/README.md`（0001–0026）。近期关键：0019 CLI 双轨、0020 workspace 桥接、0021 一对话一 agent、0022 MCP+知识包、0023 worktree、0024 oma wire fixture 契约、0025 Loop=Workflow（Loop 现已整体删除）、0026 威胁模型
- 技能：`skills/`（agentic-workflow-dsl、workflow-authoring、skill-pack-installer、about-skills）
- 自食知识包：`knowledge-packs/my-agent-team/`
- 项目 Insight（证据驱动的「为什么+行动」）：`docs/insights.md` — 与本文件（现状）、`docs/future-work.md`（待办）三层分工

## Tombstones（历史概念，勿引用）

- **Loop / CronJob / STATE.md / INBOX.md 状态机 / loop-generator / loop-verifier / Loop Doctor** — 功能整体删除，由 Workflow DSL + trigger-scheduler 承接；残留仅 schema 表与 db fixture
- **独立 plugin 包**（plugin-todo / progressive-skill / recap / pet / fs-memory）— 已吸收进 oma core 或删除；recap_update / pet_bark 事件不存在
- **packages/core / agent / agent-backend / loop / conversation / tools-common** — 并入 message / oma core / agent-contract / backend features / oma tools
- `runtime/framework.md`、`runtime/context-manager.md`、`runtime/plugin.md`、`harness/harness.md`、`backend/event-log.md` — 文档墓碑
- **PluginTool.kind（native/product 分型）** — 错误抽象已删；工具事件统一 `native_tool_started/completed`，backend 对 oma 透明
