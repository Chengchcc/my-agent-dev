---
id: runtime.oma
title: Oma Runtime
status: current
owners: architecture
summary: "oma 是 CLI 执行引擎（四种模式：print/json/rpc 一次性 + TUI 交互终端），由 Adapter 按 Run spawn 其 rpc 模式。子进程内 createOmaRuntime() 构造 per-Run Runtime：model/tool loop、in-memory SessionStore、compaction、todo、skill 渐进加载、插件加载与信任、HITL 审批。Run 级 systemPrompt/skillRoots 冻结，Meta+Prompt+full projection 三条 user 消息 seed。"
depends_on:
  - execution.agent-backend
used_by:
  - agents.context
  - architecture.workflow
---

# Oma Runtime

`apps/oh-my-agent` 是自研执行引擎：一个 CLI，四种模式。Product Backend 的 Adapter 按**每个 Agent Run** spawn 其 **rpc 模式**（非交互，stdin/stdout JSONL）；`print`/`json` 同样是一次性模式；**TUI 是面向人的交互式终端**（独立启动，不是 backend 的执行路径）。
Product Backend → Adapter (packages/adapter-oma-agent)
  → spawn oma --mode rpc
    → createOmaRuntime(): per-Run Runtime
      → model/tool loop（core/runtime/agent-loop.ts）
      → BackendRunOutcome → stdout → exit
```

**不是 daemon**：无常驻进程、无 worker pool。一个 Run = 一个子进程 = 一个 Runtime = 一个 outcome。

## CLI 模式

| 模式 | 用途 |
|---|---|
| `print` | 一次 Run；stdout 只有 final assistant text |
| `json` | 一次 Run；stdout 全部事件 JSONL + 恰好一个 terminal outcome 行 |
| `rpc` | 每 Run 一次 execute + 可选 steer/abort/resolve_approval；stdin 命令、stdout event/outcome/response |
| TUI | 交互式终端（ESC-ESC 面板、branch-tree、模型选择持久化到 `.oma/settings.json`） |

`rpc` 是 Adapter 使用的模式：严格 LF JSONL 帧，stdout 只承载协议。

## per-Run 状态：in-memory SessionStore

Runtime 状态是 **per-Run、in-memory** 的执行缓存（`core/persistence/`），不是产品历史：

```text
Agent Context  = canonical product context（跨 Run 持久、可 fork/rollback）
SessionStore   = 单次 Run 执行缓存（messages + todo + compaction 摘要）
                 子进程退出即销毁；下个 Run 重新 seed full projection
```

`sessionId = runId`；seed 时原子 appendBatch：

```text
full Product history（projected entries，带 productEntryId）
+ Meta User Message（source=meta）
+ Actual Prompt（source=prompt）
→ Agent Loop 在 session 上跑 → outcome 后 close() 销毁
```

- 同 Run 内 retry 复用同一 session（input batch 不重复追加）；steer 追加 `source=steer` 消息；follow-up 是**新 Run**（新子进程 + 新 session + 新 full seed）
- `productEntryId` 保证同一 canonical Message 在 Run 内幂等；compaction 写 `CompactionEntry`（summary + 覆盖范围），原始 entries 不删

## 模型每次收到什么

```text
System Prompt   不写 SessionStore（来自 agent_run.system_prompt 冻结快照）
Meta User Message  写 SessionStore，source=meta（Runtime Context: 日期/workspace/
                  Memory 摘要索引/skill index/branch 上下文/todo reminder）
Actual Prompt   写 SessionStore，source=prompt
Full history    写 SessionStore，source=product_history
```

- systemPrompt/skillRoots 是 Run 创建时冻结的快照；SOUL/规则变化从**下一个 Run** 生效
- 每 Run 恰好一条 Meta；retry/steer 不重新渲染 Meta；follow-up 重新读取最新快照
- skills 渐进加载：Meta 只注入 `skillRoots` 扫描出的名称/描述/加载规则，`skill_load` 按需读 `SKILL.md` 正文

## 模型系统（packages/ai）

- Provider 注册制 + Model 元数据（cost/contextWindow/maxTokens）+ `createModelRuntime()` 统一解析与 stream
- Product Backend 只保存 `BackendModelRef { backendKind, modelId }`；凭证经 env 注入子进程，不进 SessionStore/事件/日志
- Agent Loop 只自动 retry transient error（network/rate_limit/overload/5xx）；context overflow 触发 compaction recovery；auth/4xx 不盲目重试
- 模型切换：Context Branch 的 `model_change` entry 决定下一个 Run 的 effective model；当前 Run 用冻结快照值

## Runtime 拥有什么

- model/tool loop（`core/runtime/agent-loop.ts` 唯一真实 loop）
- native tools（read/write/edit/bash/grep/glob/web/eval——eval 走进程沙箱）+ MCP 工具挂载（mcp-mount 多源合并）
- retry、compaction、Run-local todo
- 插件系统：代码加载（native import）、信任矩阵（sha256 + trusted-plugins.json）、marketplace 多源 manifest（见 [Oma 插件与 HITL](../plugins/oma-plugins.md)）
- HITL 审批管道：permissionMode（ask/deny/auto）门控工具；`approval_request` → `resolve_approval`，超时 fail-closed deny
- stream rules（TTSR）：`.oma/rules/*.md` 在 assistant 文本流上匹配，命中即中止本轮、注入 `<system-reminder>` 后同轮重试
- 工具失败 system reminder：失败 tool_result 前置 `<system-reminder>`（修因重试，勿装作成功）

## 事件与终态

子进程把 Runtime 事件包装为 `RunEventEnvelope` 发 stdout；Adapter 用 `@chengchenccc/agent-contract` 的映射函数转 `BackendEvent` / `BackendRunOutcome`（completed/failed/aborted/timeout）。outcome 是唯一终态权威，事件流永不决定终态。

## 不变量

1. Oma 不是 daemon；每次被 Adapter 按 Run spawn
2. 一个 Run 一个子进程一个 Runtime；child 在 outcome 后自行退出
3. Runtime 不访问 Product DB；输入只有 full projection + snapshot
4. runId 是唯一执行身份；SessionStore 不跨 Run
5. stdout 只承载协议（rpc），stderr 只做日志
6. 每 Run 恰好一条 Meta User Message；retry/steer 不重新渲染
7. Product Tool 的权限与事实归 Product Backend，child 只经 MCP 调用
8. 插件 project-scope 代码永不进 RPC 模式加载

## 关联页面

- [Oma 插件与 HITL](../plugins/oma-plugins.md)
- [Agent Backend](../execution/agent-backend.md)
- [Agent Context](../agents/context.md)
- [Workflow](../workflow.md)
