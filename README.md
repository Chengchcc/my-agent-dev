<p align="center">
  <strong>Multi-Agent Team Runtime — 四个 Oma 后端可切换，Agent 工作区即配置文件，Web 和飞书双端实时可见</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun-14151a?style=flat-square&logo=bun" alt="Bun" />
  <img src="https://img.shields.io/badge/language-TypeScript-3178c6?style=flat-square&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT" />
</p>

---

my-agent-team 是一个**团队级 Agent 运行时**。每个 Agent 有独立的工作区（身份、技能、MCP、记忆都是工作区里的文件），运行时可以选择自研 oma 或 claude / pi / omp 四种后端，各自用原生 session 续接上下文。对话在 Web 控制台和飞书群里实时同步，Agent 由 Product Backend 按 Run 调度执行——不掉消息、不重复、所有端看到的状态一致。

## ✨ Highlights

- **四后端可切换** — 自研 oma 与 claude / pi / omp 任一运行,agent 级配置、每 Run 冻结,切后端不丢上下文(各自原生 session 续接,产品只存一个引用)
- **Agent 工作区即配置** — 身份(SOUL/USER)、技能、MCP、产品工具、知识库都是工作区里的文件(AGENTS.md / `.mcp.json` / `.<kind>/skills`),后端自动桥接,人类可直接改文件
- **一个对话一个 Agent** — 对话是 Agent session 的产品态投影;多 Agent 协作 = 多个对话投影到同一件事情(Work)上(ADR 0021)
- **多 Provider 多协议** — 支持 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 三种 API 协议;builtin provider 只需环境有 API Key 即自动生效;用户通过 `~/.oma/models.yml` 添加自定义 provider
- **Thinking/Reasoning** — 全链路支持 Anthropic extended thinking、DeepSeek reasoning_content、OpenAI reasoning_effort;Web UI 可选 thinking level
- **双端同步** — Web 控制台 + 飞书(Lark IM)Bot,同一条对话两边实时可见
- **对话账本** — canonical conversation store(conversation_ledger),所有消息经单一入口写入,端只做渲染
- **Agent Run 执行链** — 每个 Run 由 Agent Backend spawn 一次性子进程(stdin/stdout JSONL RPC),BackendRunOutcome 是唯一终态,terminal commit 原子写入 History + Context
- **Loop 自动化** — 定时触发的 Agent 流水线:Generator → Evaluator → Human Gate,自动 triage、review、cleanup
- **Product Tools** — History 读写等产品能力由 Product Backend 统一执行(幂等 + 审计)
- **SQLite 单文件存储** — backend.db,零运维部署


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

自定义 provider 或模型覆盖，在 `~/.oma/models.yml` 中声明：

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


┌──────────────────────────────────────────────────────────┐
│ Surfaces         Web 控制台  飞书 Bot                       │
├──────────────────────────────────────────────────────────┤
│ Product Backend  HTTP/SSE · 账本 · Agent Context           │
│                  Agent Run · 输入队列 · Product Tools       │
│                  Workspace Bridge(文件桥接) · Loop 调度    │
├──────────────────────────────────────────────────────────┤
│ Agent Backends   oma / claude / pi / omp          │
│ (adapters)       spawn 一次性子进程 · stdin/stdout JSONL   │
│                  session 引用透传 · steer/abort            │
├──────────────────────────────────────────────────────────┤
│ Oma     per-Run Runtime:model/tool loop、         │
│ (自研 child)     retry、compaction、todo、skills           │
│                  cwd 文件 meta + 原生 session 续接          │
│ CLI Backends     claude / pi / omp:原生读 cwd 配置、       │
│ (三方)           各自 session 存储                         │
├──────────────────────────────────────────────────────────┤
│ AI Provider层    ┌──────────────┬──────────────┬────────┐ │
│ (ADR-0018)       │ Anthropic    │ OpenAI Chat  │ OAI Resp│ │
│                  │ Messages     │ Completions  │ API     │ │
│                  └──────┬───────┴──────┬───────┴───┬────┘ │
│                  createProvider()  fetchSSE()  compat()   │
│                  ApiRegistry (OCP)   SharedSSE (DIP)      │
└──────────────────────────────────────────────────────────┘
```

一次对话的完整链路:**人发消息 -> 端 POST -> Backend 写账本 -> 创建 Agent Run -> 按后端 kind spawn 子进程(自研 child 或 CLI)-> assistant 消息流式推送(SSE)-> terminal outcome -> 原子提交最终 Message**。



### Provider 架构（ADR 0018）

```
~/.oma/models.yml          BUILTIN_CATALOG
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

> **Oma 启动方式**：开发环境 `bun run dev` 开箱即用——Backend 自动用 Bun 运行 `apps/oh-my-agent/src/cli.ts`，无需全局安装或 `bun link`。生产环境通过 `OMA_BIN` 指向构建后的 `apps/oh-my-agent/dist/cli.js` 绝对路径（详见 `apps/backend/.env.example`）。

详细架构见 [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md)。

## 📦 仓库结构

```
apps/
  backend/       Product Backend — HTTP/SSE、账本、Agent Context、Agent Run、Loop、Product Tools
  oma/  Oma CLI — print/json/rpc 模式，被 backend 按 Run spawn
  web/           Web 控制台 — Next.js 15 + shadcn/ui + React Query
  lark-bot/      飞书 Bot 适配器

  core/                    协议层：Message 类型、ChatModel、Tool、stream-utils（无 run loop）
  agent/                   Oma Runtime — 唯一真实 model/tool loop、插件、in-memory SessionStore
  agent-backend/           Agent Backend 契约：BackendRunInput/Outcome/Event + JSONL 协议 schema
  adapter-oma-agent/    Adapter — spawn 自研 child、JSONL 读写、steer/abort、并发上限
  adapter-claude-agent/    Adapter — spawn claude CLI（stream-json、--resume/--mcp-config）
  adapter-pi-agent/        Adapter — spawn pi CLI（--session/--provider/--model）
  adapter-omp-agent/       Adapter — spawn omp CLI（-r/--thinking）
  ai/                      多 API Provider 架构（ADR 0018）：ApiImplementation 注册表 +
                           createProvider 工厂 + fetchSSE 共享传输 + per-API compat 系统 +
                           BUILTIN_CATALOG + parseCatalogYAML 运行时模型配置
  loop/                    Loop 状态机（纯 reducer）
  message/                 消息类型与 MessageRevision（assistantMessageId = run:<runId>:assistant:<n>）
  conversation/            LedgerEntry codec（一个对话一个 Agent，见 ADR 0021）
  tools-common/            通用工具：read/write/edit/bash/grep/glob
  api-contract/            跨进程类型契约（SSE 事件、Eden Treaty）
  config/                  配置加载
  plugin-todo/             Run-local todo 跟踪（Oma 加载）
  plugin-progressive-skill/ 渐进式技能加载（Oma 加载）
  plugin-recap/            上下文超出时的回溯摘要（Oma 加载）
  test-helpers/            测试工具（echoModel）
```

## 📖 文档

| 文档 | 说明 |
|---|---|
| [架构 Wiki](docs/architecture/README.md) | 入口，按「你想干什么」组织阅读路线 |
| [系统总览](docs/architecture/system-overview.md) | 执行链 + 容器视图 + 不变量 |
| [ADR 索引](docs/adr/README.md) | 全部决策记录（0001–0021，含状态标注） |
| [Provider 架构](docs/architecture/provider-architecture-spec.md) | 多 API Provider 设计规范（SOLID） |
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

> **数据库升级策略**：迁移只保证 fresh-boot 路径。改动 schema 后若旧开发库
> 启动异常，直接删掉 `apps/backend/.backend-data/` 重启即可（开发数据,非持久
> 事实）——不存在 in-place 升级路径,旧库兼容问题不修。

## 📄 License

MIT
