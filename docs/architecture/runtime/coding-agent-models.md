---
id: runtime.coding-agent-models
title: Coding Agent Provider 与 ModelRuntime
status: design
owners: architecture
summary: "Coding Agent Daemon 内置 Provider + ModelRuntime：Provider 拥有 auth、model catalog、协议转换和 stream；ModelRuntime 管 Provider registry、CredentialStore、catalog refresh、model availability 与 dispatch。Product Backend 只通过 CodingAgentBackend 模型目录选择 BackendModelRef。"
depends_on:
  - runtime.coding-agent
used_by:
  - runtime.coding-agent-prompt
---

# Coding Agent Provider 与 ModelRuntime

Coding Agent 需要自己的模型系统，因为它不是 Claude Code 或 Codex 的包装器，而是直接调用模型 API 的 Agent Backend。设计参考 Pi 的 Provider/Models 职责拆分，并演进当前 `packages/ai` 的 Provider、Model、API registry；本架构统一将聚合服务命名为 `ModelRuntime`。

## 模型配置由谁负责

```text
Product Backend
  owns selected BackendModelRef
  reads a separate BackendModelCatalog

Coding Agent
  publishes available BackendModel entries
  owns Provider registry + ModelRuntime + CredentialStore + stream dispatch
```

Product Backend 不读取 provider credentials，不调用 provider SDK，也不依赖 Coding Agent 的 Provider 类型。

模型 API 调用在每个 Session Worker 内执行。Daemon CredentialStore 只向 worker 提供当前 provider/request 所需的最小 credential material；worker 不把 credential 写入 Coding Session Tree、事件或日志。

## Product Backend 如何引用模型

```ts
interface BackendModelRef {
  backendKind: "coding-agent";
  modelId: string; // canonical form: provider/model
}
```

Product Agent 保存默认 model；Context Branch 的 `ModelChangeEntry` 保存后续 Agent Run 的 effective model。当前 active Agent Run/Agent Loop 不因 model change 中途改变。

## Provider 负责什么

```ts
interface Provider {
  readonly id: string;
  readonly name: string;
  readonly auth: ProviderAuth;

  getModels(): readonly Model[];
  refreshModels?(ctx: RefreshModelsContext): Promise<void>;
  filterModels?(models: readonly Model[], credential?: Credential): readonly Model[];

  stream(
    model: Model,
    context: ModelContext,
    options?: StreamOptions,
  ): AssistantMessageEventStream;
}
```

Provider 拥有：

- auth semantics；
- model catalog；
- base URL / static headers；
- provider/API message conversion；
- streaming 与 provider error normalization。

## ModelRuntime 负责什么

```ts
interface ModelRuntime {
  getProviders(): readonly Provider[];
  getModels(providerId?: string): readonly Model[];
  getModel(providerId: string, modelId: string): Model | undefined;
  getAvailable(providerId?: string): Promise<readonly Model[]>;
  refresh(options?: RefreshOptions): Promise<RefreshResult>;
  stream(model: Model, context: ModelContext, options?: StreamOptions): AssistantMessageEventStream;
}
```

ModelRuntime 负责：

- Provider 注册与替换；
- CredentialStore 解析与 OAuth refresh；
- 动态 catalog 持久缓存和 refresh；
- 按 credential 过滤可用模型；
- request-scoped auth/header 组合；
- stream dispatch。

## Provider 凭证保存在哪里

Daemon 是单租户 trust boundary，并独立持有 Provider credentials。

```text
Product Backend never receives provider secret
Worker never logs provider secret
Session Tree never stores provider secret
SSE/events never contain provider secret
```

CredentialStore 首版复用 Daemon 部署环境或 OS keychain，不新增自定义加密数据库。只有出现需要运行时增删多套 credential 的真实需求时，再引入独立加密存储。Product Backend service token 无权读取 credential 内容。

诊断 API 只返回：

```text
configured
missing
refresh_failed
```

## Product Backend 如何列出可用模型

Coding Agent 的 model catalog adapter 将内部 ModelRuntime 目录映射为独立 `BackendModelCatalog`。它不是 `AgentBackend` 的方法；AgentBackend 仍只负责 start/send/resume/respond/stop/close。

```ts
interface BackendModel {
  id: string; // provider/model
  displayName: string;
  reasoning: boolean;
  inputModalities: readonly string[];
  contextWindow: number;
  maxOutputTokens: number;
  available: boolean;
}
```

Product Backend 聚合不同 Agent Backend 的目录。ModelRef 必须匹配 Context Branch 的 backendKind。

## 切换模型何时生效

Context Branch 写 `ModelChangeEntry`，下一个 Agent Run 生效。

Coding Agent Adapter 的策略：

```text
Coding Session 支持 loop 边界切换 model
→ 保留 session，下一 loop 使用新 model

model/API 变化要求重新初始化 worker/session
→ binding stale
→ 从 Context Branch 重建同 backendKind Coding Session
```

Coding Session Tree 不保存 ModelChangeEntry；model 来自每个 Agent Run 的 `AgentRunSnapshot`。Loop metadata 保存实际使用的 provider/model 和 systemPromptHash，供诊断。

## 哪些错误会自动重试

Provider 将错误规范化为：

```text
transient: network / rate_limit / overload / 5xx
context_overflow
auth
invalid_request
fatal
aborted
```

Agent Loop 仅自动 retry transient error。Context overflow 触发 Runtime compaction recovery。Auth、invalid request、tool/business error 不盲目 retry。

## 如何演进现有 packages/ai

当前 `packages/ai` 已有：

```text
Provider
Model
ModelRegistry
API implementations
Anthropic/OpenAI-compatible providers
resolveModel
```

目标演进：

```text
ModelRegistry → ModelRuntime
Provider.createModel → Provider.stream
增加 CredentialStore
增加 dynamic catalog refresh/cache
增加 availability filter
统一 provider error normalization
```

Agent Runtime core 依赖 ModelRuntime 接口，不依赖具体 Provider SDK。

## 不变量

1. Product Backend 只保存 BackendModelRef。
2. Provider credentials 只在 Runtime Daemon。
3. Provider 拥有 auth/catalog/stream 语义。
4. ModelRuntime 统一 registry、credential、refresh 与 dispatch。
5. Model change 在下一个 Agent Run/Agent Loop 生效。
6. 当前 active Agent Run/loop 的 model 不变。
7. Coding Session Tree 不保存 credentials。
8. Adapter 只暴露统一 model catalog，不泄漏 Provider 内部对象。

## 关联页面

- [Coding Agent](./coding-agent.md)
- [Coding Agent Prompt 与 Context](./coding-agent-prompt.md)
- [Coding Agent Session](./coding-agent-session.md)
- [Agent Backend](../execution/agent-backend.md)
