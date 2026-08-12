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
- **多 Provider 多协议** — 支持 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 三种 API 协议；6 个 builtin provider（Anthropic / OpenAI / DeepSeek / Groq / OpenRouter）只需环境有 API Key 即自动生效；用户通过 `~/.my-agent/models.yml` 添加自定义 provider
- **Thinking/Reasoning** — 全链路支持 Anthropic extended thinking（adaptive/budget/signature replay）、DeepSeek reasoning_content、OpenAI reasoning_effort；Web UI 可选 thinking level
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

# 设置至少一个 provider 的 API Key
export ANTHROPIC_API_KEY=sk-ant-...
# 或 OPENAI_API_KEY / DEEPSEEK_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY

bun run dev
```

`dev` 会并行启动 backend（HTTP/SSE）和 web（Next.js）。打开：

| 服务 | 地址 |
|---|---|
| Web 控制台 | `http://localhost:3001` |
| Backend API | `http://localhost:3000` |

### 配置模型 Provider

Builtin provider 只需环境变量有对应的 API Key 即自动可用：

| Provider | 环境变量 | 可用模型 |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | Claude Opus 4.8, Sonnet 5, Haiku 4.5 |
| OpenAI | `OPENAI_API_KEY` | GPT-5.4, GPT-5.2, GPT-5 Mini, o4 Mini |
| DeepSeek | `DEEPSEEK_API_KEY` | DeepSeek V4 Flash, V4 Pro |
| Groq | `GROQ_API_KEY` | Llama 3.3 70B |
| OpenRouter | `OPENROUTER_API_KEY` | Claude Sonnet 5 + 更多 |

自定义 provider 或模型覆盖，在 `~/.my-agent/models.yml` 中声明：

```yaml
providers:
  my-provider:
    api: openai-completions          # 或 anthropic-messages / openai-responses
    baseUrl: https://my-api.example.com/v1
    apiKeyEnv: MY_API_KEY
    models:
      - id: my-model-v1
        name: My Custom Model
        reasoning: true
        contextWindow: 128000
        maxTokens: 8192
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }
        thinking:
          mode: effort                # effort | budget | adaptive
          efforts: [off, low, high]
        compat:
          thinkingFormat: deepseek    # deepseek | qwen | zai | openrouter
          maxTokensField: max_tokens  # 或 max_completion_tokens
```

## 🧱 架构

```
┌──────────────────────────────────────────────────────────┐
│ Surfaces         Web 控制台  飞书 Bot                       │
├──────────────────────────────────────────────────────────┤
│ Product Backend  HTTP/SSE · 账本 · Agent Context           │
│                  Agent Run · 输入队列 · Product Tools       │
│                  Loop 调度                                 │
├──────────────────────────────────────────────────────────┤
│ Agent Backend    spawn 一次性 coding-agent 子进程           │
│ (adapter)        stdin/stdout JSONL · steer/abort          │
├──────────────────────────────────────────────────────────┤
│ Coding Agent     per-Run Runtime：model/tool loop、         │
│ (child process)  retry、compaction、todo、skills           │
│                  provider 注册 · model catalog              │
├──────────────────────────────────────────────────────────┤
│ AI Provider层    ┌──────────────┬──────────────┬────────┐ │
│ (SOLID/ADR-0018) │ Anthropic    │ OpenAI Chat  │ OAI Resp│ │
│                  │ Messages     │ Completions  │ API     │ │
│                  └──────┬───────┴──────┬───────┴───┬────┘ │
│                  createProvider()  fetchSSE()  compat()   │
│                  ApiRegistry (OCP)   SharedSSE (DIP)      │
└──────────────────────────────────────────────────────────┘
```

一次对话的完整链路：**人发消息 -> 端 POST -> Backend 写账本 -> 创建 Agent Run -> spawn coding-agent 子进程 -> assistant 消息流式推送（SSE）-> terminal outcome -> 原子提交最终 Message**。

### Provider 架构（ADR 0018）

```
~/.my-agent/models.yml          BUILTIN_CATALOG
       │ (运行时读取)                │ (TypeScript 内置)
       └─────── merge ───────────────┘
                    │
         buildAllModels() → createProvider()
                    │
         modelRuntime.registerProvider()
                    │
    ┌───────────────┴───────────────────┐
    │ stream(model, messages, opts)      │
    │   getApiImplementation(model.api)  │ ← OCP: 注册表分派
    │   impl.buildRequest()              │ ← SRP: 造 wire payload
    │   fetchSSE(url, headers, body)     │ ← DIP: 共享传输
    │   impl.createChunkConverter()      │ ← SRP: 解码 SSE
    └────────────────────────────────────┘
```

> **Coding Agent 启动方式**：开发环境 `bun run dev` 开箱即用——Backend 自动用 Bun 运行 `apps/coding-agent/src/cli.ts`，无需全局安装或 `bun link`。生产环境通过 `CODING_AGENT_BIN` 指向构建后的 `apps/coding-agent/dist/cli.js` 绝对路径（详见 `apps/backend/.env.example`）。

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
  ai/                      多 API Provider 架构（ADR 0018）：ApiImplementation 注册表 +
                           createProvider 工厂 + fetchSSE 共享传输 + per-API compat 系统 +
                           BUILTIN_CATALOG + parseCatalogYAML 运行时模型配置
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
| [Provider 架构](docs/architecture/provider-architecture-spec.md) | 多 API Provider 设计规范（SOLID） |
| [ADR 0018](docs/adr/0018-multi-api-provider-architecture.md) | 多 API Provider 架构决策记录 |
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
