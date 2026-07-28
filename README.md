<p align="center">
  <strong>Multi-Agent Team Runtime — 人 + 多个 Agent 在同一对话里协作，Web 和飞书双端实时可见</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun-14151a?style=flat-square&logo=bun" alt="Bun" />
  <img src="https://img.shields.io/badge/language-TypeScript-3178c6?style=flat-square&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT" />
</p>

---

my-agent-team 是一个**团队级 Agent 运行时**。把多个 AI Agent 拉进同一个对话里，和人类一样 `@mention`、分工、并行干活。对话在 Web 控制台和飞书群里实时同步，Agent 在服务端进程内执行——不掉消息、不重复、所有端看到的状态一致。

## ✨ Highlights

- **多 Agent 协作** — 人和多个 Agent 在同一对话里 `@mention` 交互，每个 Agent 有独立身份、记忆和工具白名单
- **双端同步** — Web 控制台 + 飞书（Lark IM）Bot，同一条对话两边实时可见
- **对话账本** — canonical conversation store，所有消息（人 + Agent）经单一入口写入，端只做渲染
- **Loop 自动化** — 定时触发的 Agent 流水线：Generator → Evaluator → Human Gate，自动 triage、review、cleanup
- **插件体系** — 身份注入、渐进式技能加载、文件记忆、对话上下文、任务防早停，6 个生命周期 hook
- **进程内编排** - Agent 直管运行循环 + 持久化端口 + Plugin + ContextPipeline，无额外服务依赖
- **SQLite 单文件存储** — backend.db（业务） + checkpointer.db（执行），零运维部署

## 🚀 快速开始

**前置条件：** [Bun](https://bun.sh) >= 1.3

```bash
bun install
bun run dev
```

`dev` 会并行启动 backend（HTTP/SSE）和 web（Next.js）。打开：

| 服务 | 地址 |
|---|---|
| Web 控制台 | `http://localhost:3000` |
| Backend API | `http://localhost:3001` |

## 🧱 架构

```
┌─────────────────────────────────┐
│ Surfaces       Web 控制台  飞书 Bot │
├─────────────────────────────────┤
│ Backend        HTTP/SSE · Agent 编排 · Loop 调度 │
├─────────────────────────────────┤
│ Agent Runtime  createAgentSession() · 插件 · 持久化端口 · ContextPipeline │
├─────────────────────────────────┤
│ Storage        backend.db + checkpointer.db（SQLite）      │
└─────────────────────────────────┘
```

一次对话的完整链路：**人发消息 -> 端 POST -> Backend 写账本 -> Agent 拉起运行循环 -> assistant 消息直写账本 -> SSE 推到所有端**。

详细架构见 [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md)。

## 📦 仓库结构

```
apps/
  backend/    Team Runtime — HTTP/SSE 服务、对话、运行、Loop 调度
  web/        Web 控制台 — Next.js 15 + shadcn/ui + React Query
  lark-bot/   飞书 Bot 适配器

packages/
  core/                    运行时原语：Message、Tool、ChatModel、run()
  agent/                   Agent 生命周期、createAgentSession()、插件、ContextPipeline、持久化端口
  loop/                    Loop 状态机（纯 reducer）
  ai/                      Provider 注册制 + Model 元数据 + AnthropicChatModel
  message/                 消息类型与 MessageRevision
  conversation/            成员、@提及、LedgerEntry codec
  tools-common/            通用工具：read/write/edit/bash/grep/glob
  api-contract/            跨进程类型契约（Eden Treaty）
  config/                  配置加载
  plugin-identity/         Agent 身份（SOUL/USER/记忆）
  plugin-fs-memory/        文件型长期记忆
  plugin-progressive-skill/ 渐进式技能加载
  plugin-task-guard/       任务规划与防早停
  plugin-conversation-context/ 对话上下文注入
  runtime-observability/   运行可观测性
  test-helpers/            测试工具（echoModel）
```

## 📖 文档

| 文档 | 说明 |
|---|---|
| [架构 Wiki](docs/architecture/README.md) | 入口，按「你想干什么」组织阅读路线 |
| [系统总览](docs/architecture/system-overview.md) | 容器视图 + 运行时序 + 不变量 |
| [事实与投影](docs/architecture/foundations/facts-and-projections.md) | 数据模型的核心设计原则 |
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
