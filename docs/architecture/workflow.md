---
id: architecture.workflow
title: Agentic Workflow
status: current
owners: architecture
summary: "Workflow 是声明式节点图编排：start/end/agent/script/human 五类节点 + JSON-Logic 条件边 + cron 触发。一次运行是一个 WorkflowExecution（execution/node_run/pending_human 三表 + SSE live/replay）；agent 节点派发普通 Agent Run（outputSchema 约束 + harness 级 schema retry），script 节点在进程沙箱执行，human 节点在 Web 表单上挂起；Artifact 是节点间与聊天中的带类型产物引用。"
depends_on:
  - architecture.system-overview
  - backend.overview
used_by:
  - surfaces.web
---

# Agentic Workflow

Workflow 是继 Loop（2026-08-28 删除）之后的自动化执行模型：**声明式节点图，文件即定义，执行即持久实例**。

## DSL（`@chengchenccc/workflow` 纯域层）

`*.workflow.json` 定义（默认目录 `dataDir/workflows/`）：

```text
version / id / meta / input（key-type 数组，type 可为 string|number|boolean|artifact）
nodes:  start | end(status) | agent | script | human
edges:  { from, to, when?: JSON-Logic 子集 }
triggers: { type: "cron", cron, enabled? }
```

- **start** 输出 = execution 输入；**end** 的 `status` 决定终态（`success`→success、`failure`→failure、其余→custom）
- **agent**：`agentId` 引用系统 agent（推荐）或内联 `{model, prompt}`；输出经 `outputSchema` 约束
- **script**：TS `export default (ctx) => output`，`ctx` = 上游合并输入（裸输入，无宿主能力注入）
- **human**：静态 `question`/`form` 或上游动态传入；execution 挂起于 `waiting_human`

## 执行引擎

- `computeNext`（纯函数）：完成节点路由在完成时冻结进 `CompletionRecord.routedTo`，**永不重算**；join 语义 = any-of（AND 需显式 DSL marker）
- `mergeInputs`：trigger → store → 全部完成输出按 completion order 合并（后者胜出），`nextNode` 输出字段是控制字段不并入数据
- JSON-Logic 子集：`==`/`!=`（JSON 深比较）、`>`/`>=`/`<`/`<=`、`in`、`and`/`or`/`not`、`if`（严格三元）、`var`（点路径 + default）、`!!`

## 执行路径（backend `features/workflow`）

```text
cron 到点(Bun.cron trigger-scheduler) / 手动 POST / 模板实例化
→ startExecution：创建 WorkflowExecution（status=running，definition 冻结）
→ drive：computeNext 逐步推进
   agent 节点 → conversationService.postMessage（conversationId = workflow:<executionId>:<nodeId>）
              → 派发普通 Agent Run（outputSchema 约束 + 失败时 harness 级 schema retry）
   script 节点 → runInSandbox（进程沙箱：spawn bun、临时 cwd、最小 env、硬超时、JSON stdio）
   human 节点 → createPendingHuman + status=waiting_human → Web 表单 → resolveHumanTask 续跑
→ end → terminal（exit 冻结进 execution）
```

- 事件流：execution_started / node_started / node_agent_started|completed / script_log / node_completed|failed / human_task_requested / execution_terminal；SSE 端点 `subscribe 先注册（事件缓冲）→ 重放持久历史 → 直播`，关闭重放缺口
- 取消：running 由 drive 循环观察 cancelled 标记收尾；waiting_human 直接终态化
- 恢复：启动时 `recover()` 重驱所有 running execution（agent 节点按持久 runId 重连轮询，不重复触发）

## Artifact（`features/artifact`）

带类型的产物引用：input/output hint 里 `type: "artifact"` 的字段值必须是 `artifacts://<id>`；fs 存储 + MCP 工具 + REST；节点 input/output 与 execution input 做存在性校验；聊天中可 @-mention 引用。Artifact 把「一次运行产出了什么」从聊天流里提出来，成为节点间可传递的一等数据。

## 与 Agent Run 的关系

- Workflow **不**是新的执行身份：agent 节点创建的是普通 Agent Run（agent_run 表、BackendRunOutcome 终态、terminal commit 不变）
- workflow execution 是编排层身份：execution / node_run / pending_human 三表只描述「图跑到哪了」，不承载对话事实
- 脚本式 `BackendRunInput.workflow`（ADR 0025 遗留的 Run 级脚本输入）是另一条独立路径：oma child 内的 `core/workflow/workflow-executor.ts` 直接执行脚本 + subagent registry

## 不变量

1. 引擎纯函数；路由完成时冻结，永不重算
2. script 节点永远经进程沙箱（进程边界，非 fs jail；ADR 0026 边界内接受）
3. agent 节点输出必须过 outputSchema（失败→带错误反馈重试→节点 failed）
4. 节点失败逐节点记录（node_run.error），execution 以 failure 终态，不整图静默
5. Artifact 引用在节点边界校验存在性（不存在即节点失败）

## 关联页面

- [系统总览](./system-overview.md)
- [Product Backend 总览](./backend/overview.md)
- [事实与投影](./foundations/facts-and-projections.md)
- [ADR 0025（Loop=Workflow 决策）](../adr/0025-loop-workflow-first-execution.md)
- [ADR 0026（威胁模型）](../adr/0026-agent-threat-model.md)
