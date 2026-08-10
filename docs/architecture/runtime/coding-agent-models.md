---
id: runtime.coding-agent-models
title: Coding Agent Provider 与 ModelRuntime
status: current
owners: architecture
summary: "模型系统由 packages/ai 提供：Provider 注册制 + Model 元数据 + ModelRuntime（createModelRuntime）。Product Backend 只保存 BackendModelRef（backendKind=coding_agent + modelId）；子进程内解析并 stream。无 daemon CredentialStore —— 凭证来自 Product Backend 环境。"
depends_on:
  - runtime.coding-agent
used_by:
  - runtime.coding-agent-prompt
---

# Coding Agent Provider 与 ModelRuntime

Coding Agent 直接调用模型 API（不是外部 Runtime 的包装器）。模型系统在 `packages/ai`：Provider 注册制、Model 元数据（cost/contextWindow/maxTokens）、`createModelRuntime()` 统一解析与 stream。

## 模型配置由谁负责

```text
Product Backend
  owns BackendModelRef { backendKind: "coding_agent", modelId }（agent 记录 / Run 快照）

Coding Agent（子进程）
  resolveModel(modelId) → Provider.stream(...)
```

Product Backend 不读取 provider credentials 细节，不调用 provider SDK。子进程的模型凭证来自 Product Backend 注入的环境（与 Product Tools token 相同的 env 注入方式）。

## 哪些错误会自动重试

Provider 将错误规范化后，Agent Loop 仅自动 retry transient error（network / rate_limit / overload / 5xx）。Context overflow 触发 Runtime compaction recovery。Auth、invalid request、tool/business error 不盲目 retry。

## 切换模型何时生效

Context Branch 的 `model_change` entry 决定下一个 Agent Run 的 effective model。当前 active Run 的 model 是 Run 快照冻结值，中途不变；下一个 Run 使用新 model（新子进程，无 session 需要保留）。

## 不变量

1. Product Backend 只保存 BackendModelRef。
2. 模型凭证在子进程环境内使用，不进入 SessionStore、事件或日志。
3. Provider 拥有 auth/catalog/stream 语义；ModelRuntime 统一 registry 与 dispatch。
4. Model change 在下一个 Agent Run 生效；当前 Run 的 model 不变。
5. Adapter 只暴露统一 model catalog（`BackendModelCatalog`），不泄漏 Provider 内部对象。

## 关联页面

- [Coding Agent](./coding-agent.md)
- [Coding Agent Prompt 与 Context](./coding-agent-prompt.md)
- [Coding Agent Session](./coding-agent-session.md)
- [Agent Backend](../execution/agent-backend.md)
