---
id: runtime.oma
title: Oma
status: current
owners: architecture
summary: "oma 是无 UI 的 CLI 执行引擎（print/json/rpc 三种模式），由 Adapter 按 Run spawn 一次性子进程。子进程内 createOmaRuntime() 构造 per-Run Runtime（packages/agent），跑完产出 BackendRunOutcome 后自行退出。"
depends_on:
  - execution.oma-backend
used_by:
  - runtime.oma-session
  - runtime.oma-prompt
  - runtime.oma-models
---

# Oma

`apps/oh-my-agent` 是当前唯一的 Agent 执行引擎：一个无 UI 的 CLI，被 Product Backend 的 Adapter 按 **每个 Agent Run** spawn 一次。

```text
Product Backend
  → Adapter (packages/adapter-oma-agent)
      → spawn oma --mode rpc
          → createOmaRuntime()：per-Run Runtime
              → model/tool loop（packages/agent）
              → BackendRunOutcome → stdout → exit
```

**不是 daemon**：没有常驻进程、没有 session supervisor、没有 worker pool。一个 Run = 一个子进程 = 一个 Runtime = 一个 outcome。

## CLI 模式

| 模式 | 用途 |
|---|---|
| `print` | 一次 Run；stdout 只有 final assistant text；stderr 日志；非零退出码表示失败 |
| `json` | 一次 Run；stdout 全部事件 JSONL + 恰好一个 terminal outcome 行 |
| `rpc` | 每 Run 一次 execute + 可选的 steer/abort 命令；命令走 stdin，event/outcome/response 走 stdout |

`--mode rpc` 是 Adapter 使用的模式：严格 LF JSONL 帧，stdout 只承载协议，stderr 只做日志。

## per-Run Runtime

`createOmaRuntime()`（`src/core/create-runtime.ts`）构造一个 Runtime = 一个 Run：

- `run(input)` 返回唯一 segment；其 `outcome` 是 Run 的唯一终态；
- `steer(input)` 注入 live loop；`stop()` 中止它；
- `close()` 拆除 MCP clients 与 SessionStore。

Runtime 内部由 `packages/agent` 提供：OmaSession（模型/工具循环、retry、compaction、beforeModel 插件、todo）与 in-memory SessionStore。SessionStore 在 seed 时把 **full Product history + meta + input** 原子写入，loop 从完整投影开始，Run 结束即销毁 —— 无跨 Run 状态。

## Runtime 拥有什么

- model/tool loop（`packages/agent/src/runtime/agent-loop.ts` 是唯一真实 loop）；
- native tools（文件/Shell/搜索/glob/grep 等）；
- retry（transient error 自动重试）；
- compaction（token 预算内摘要，Run-local）；
- Run-local todo（`todo` 工具）；
- progressive skill loading（`packages/plugin-progressive-skill`，按 Run 冻结的 `skillRoots` 扫描 SKILL.md）；
- Product Tools MCP 客户端（调用 Product Backend 的产品能力，身份/权限/审计归 Product）。

## 事件与终态

子进程把 Runtime 事件包装为 `RunEventEnvelope { id, type, data }` 发 stdout；Adapter 用契约包（`@chengchenccc/agent-backend`）的 `mapRunEvent` / `mapRunOutcome` 映射为 `BackendEvent` / `BackendRunOutcome`（completed/failed/aborted/timeout）。outcome 是唯一终态权威。

## 不变量

1. Oma 不是 daemon；每次被 Adapter 按 Run spawn。
2. 一个 Run 一个子进程一个 Runtime；child 在 outcome 后自行退出。
3. Runtime 不访问 Product DB；输入只有 full projection + snapshot。
4. runId 是唯一执行身份；子进程内无跨 Run session。
5. stdout 只承载协议（rpc 模式），stderr 只做日志。
6. Product Tool 的权限与事实归 Product Backend，child 只通过 MCP 调用。

## 关联页面

- [Oma Session](./coding-agent-session.md)
- [Oma Prompt 与 Context](./coding-agent-prompt.md)
- [Oma Provider 与 ModelRuntime](./coding-agent-models.md)
- [Agent Backend](../execution/agent-backend.md)
