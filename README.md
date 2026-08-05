<p align="center">
  <strong>Multi-Agent Team Runtime — 人 + 多个 Agent 在同一对话里协作，Web 和飞书双端实时可见</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun-14151a?style=flat-square&logo=bun" alt="Bun" />
  <img src="https://img.shields.io/badge/language-TypeScript-3178c6?style=flat-square&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT" />
</p>

---

my-agent-team 是一个**团队级 Agent 运行时**。把多个 AI Agent 拉进同一个对话里，和人类一样 `@mention`、分工、干活。对话在 Web 控制台和飞书群里实时同步，Agent 由 Product Backend 按 Run 调度执行——不掉消息、不重复、所有端看到的状态一致。

## ✨ Highlights

- **多 Agent 协作** — 人和多个 Agent 在同一对话里 `@mention` 交互，每个 Agent 有独立身份、记忆、Skill Pack 和工具白名单
- **双端同步** — Web 控制台 + 飞书（Lark IM）Bot，同一条对话两边实时可见
- **对话账本** — canonical conversation store（conversation_ledger），所有消息（人 + Agent）经单一入口写入，端只做渲染
- **Agent Run 执行链** — 每个 Run 由 Agent Backend spawn 一次性 coding-agent 子进程（stdin/stdout JSONL RPC），BackendRunOutcome 是唯一终态，terminal commit 原子写入 History + Context
- **Agent Context / Branch** — 每个 Agent 实际消费的语义历史，支持 fork/rollback，是跨 Run 恢复的唯一真源
- **Loop 自动化** — 定时触发的 Agent 流水线：Generator → Evaluator → Human Gate，自动 triage、review、cleanup
- **Product Tools** — History 读写、审批等产品能力由 Product Backend 统一执行（幂等 + 审计）
- **SQLite 单文件存储** — backend.db，零运维部署

## 🚀 快速开始

**前置条件：** [Bun](https://bun.sh) >= 1.3

```bash
bun install
bun run dev
```

`dev` 会并行启动 backend（HTTP/SSE）和 web（Next.js）。打开：

| 服务 | 地址 |
|---|---|
| Web 控制台 | `http://localhost:3001` |
| Backend API | `http://localhost:3000` |

## 🧱 架构

```
┌────────────────────────────────────────────────────┐
│ Surfaces       Web 控制台  飞书 Bot                  │
├────────────────────────────────────────────────────┤
│ Product Backend  HTTP/SSE · 账本 · Agent Context    │
│                  Agent Run · 输入队列 · Product Tools│
│                  Loop 调度                          │
├────────────────────────────────────────────────────┤
│ Agent Backend   spawn 一次性 coding-agent 子进程     │
│ (adapter)       stdin/stdout JSONL · steer/abort    │
├────────────────────────────────────────────────────┤
│ Coding Agent    per-Run Runtime：model/tool loop、   │
│ (child process) retry、compaction、todo、skills     │
└────────────────────────────────────────────────────┘
```

一次对话的完整链路：**人发消息 -> 端 POST -> Backend 写账本 -> 创建 Agent Run -> spawn coding-agent 子进程 -> assistant 消息流式推送（SSE）-> terminal outcome -> 原子提交最终 Message**。

详细架构见 [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md)。

## 📦 仓库结构

```
apps/
  backend/       Product Backend — HTTP/SSE、账本、Agent Context、Agent Run、Loop、Product Tools
  coding-agent/  Coding Agent CLI — print/json/rpc 模式，被 backend 按 Run spawn
  web/           Web 控制台 — Next.js 15 + shadcn/ui + React Query
  lark-bot/      飞书 Bot 适配器

packages/
  core/                    协议层：Message 类型、ChatModel、Tool、stream-utils（无 run loop）
  agent/                   Coding Agent Runtime — 唯一真实 model/tool loop、插件、in-memory SessionStore
  agent-backend/           Agent Backend 契约：BackendRunInput/Outcome/Event + JSONL 协议 schema
  adapter-coding-agent/    Adapter — spawn child、JSONL 读写、steer/abort、并发上限
  ai/                      Provider 注册制 + Model 元数据 + AnthropicChatModel + ModelRuntime
  loop/                    Loop 状态机（纯 reducer）
  message/                 消息类型与 MessageRevision（assistantMessageId = run:<runId>:assistant:<n>）
  conversation/            成员、@提及、LedgerEntry codec
  tools-common/            通用工具：read/write/edit/bash/grep/glob
  api-contract/            跨进程类型契约（SSE 事件、Eden Treaty）
  config/                  配置加载
  plugin-todo/             Run-local todo 跟踪（Coding Agent 加载）
  plugin-progressive-skill/ 渐进式技能加载（Coding Agent 加载）
  test-helpers/            测试工具（echoModel）
```

## 📖 文档

| 文档 | 说明 |
|---|---|
| [架构 Wiki](docs/architecture/README.md) | 入口，按「你想干什么」组织阅读路线 |
| [系统总览](docs/architecture/system-overview.md) | 执行链 + 容器视图 + 不变量 |
| [事实与投影](docs/architecture/foundations/facts-and-projections.md) | 数据模型的核心设计原则 |
| [Agent Backend](docs/architecture/execution/agent-backend.md) | Agent Backend 协议与 child-process transport |
| [未来工作](docs/architecture/roadmap/future-work.md) | 已知缺口和演进方向 |

## 🛠 开发

```bash
bun run format      # Biome 格式化
bun run lint        # Biome + ESLint
bun run typecheck   # tsc --noEmit（全仓）
bun run test        # 全仓测试
bun run build       # 全仓构建（turbo）
```

## 📄 License

MIT
