# Spec: Agentic Workflow 引擎 — 删除 loop，以 DSL 化 workflow 取代

## Problem

当前 `apps/backend/src/features/loop/` 是硬编码状态机：`ItemStep` 七态
（triaged → fixing → verifying → awaiting_review → resolved），generator/evaluator
两个 agent run + git worktree + HITL review，流转逻辑写死在 reducer 里。LOOP.md
只能改 prompt/模型，**加不了分支、插不了自定义节点、不支持并行**。

方向（2026-08-27 与用户确认，十一轮收敛）：删除 loop，以 Coze 式 agentic
workflow 取代——DSL 描述 DAG，多节点类型，外部触发器，编辑器。本轮只出 spec，不实现。

## 决策摘要（已确认）

1. **流转控制权**：静态边为主 + agent 节点可选 `nextNode` 覆盖（混合 C）。
2. **引擎通用**（B）：workflow 不绑 repo；repo 是节点级可选 context。
3. **并行**：fan-out 支持，AND-join。
4. **边条件**：JSONLogic **子集**表达式（语义见 Design），对**来源节点（from）output + store** 求值；跨节点取值经 store 显式中转。
5. **数据流**：隐式合并 = **全局合并**——下游 input = store 快照 + **全部已完成节点** output（非仅上游），后完成覆盖；并行分支作者需避免 key 相撞（provenance 记录赢家）。
6. **类型**：轻量——input 只声明可选默认值/必填，output 声明类型提示，不强制校验。
7. **store**：execution 级 KV，仅节点通过 runtime API 显式写。
8. **human 节点** = "问用户问题"能力（AskUserQuestion 式），问题静态声明或上游动态生成，前端渲染表单，答案 = output。
9. **存储**：file-first，DSL 是 git 仓库里的 `*.workflow.json`，迁移 = git 搬运（长期 hub 战略）。
10. **触发器外部绑定**（B）：复用现有 cron 系统 + 新增 API 端点，DSL 纯逻辑。
11. **编辑器 v1**：画布只读渲染 + 节点属性面板 + chat 改 DSL；v2 拖拽连线。
12. **agent 节点**：`{agentId}` 引用系统 agent（推荐）或内联 `{model, prompt}`。
13. **script 节点**：TS 函数，注入 `ScriptContext`（input/store/context/log），无 model/exec 注入。
14. **多出口**：end 节点带 `status` 标签（success/failure/自定义）。
15. **包结构**：engine + editor 基础能力独立成 `packages/workflow`（`@chengchenccc/workflow`）。

## Goal

1. DSL 描述 workflow：节点（start/end/agent/script/human）、边（JSONLogic 条件）、多出口。
2. 执行引擎：一次运行 = 一个 execution，节点级 context + 跨节点 store，事件流可观测。
3. 触发器：现有 CronJob 增加 workflow target；新增 `POST /api/workflow-executions`。
4. 编辑器 v1：只读画布 + 属性面板 + chat 改 DSL（git 提交）。
5. 删除 `apps/backend/src/features/loop/`（workflow 取代，不做迁移）。
6. engine + editor 基础能力独立成 `@chengchenccc/workflow` 包，backend/web 消费它。

## Non-goals（v1）

- 拖拽连线画布（v2）。
- 表达式引擎之外的强类型系统（不强制 schema 校验）。
- per-node 失败边（统一走 failure 出口）。
- 多租户 workflow hub 平台（长期方向，非本轮）。
- 独立 condition 节点（条件在边上表达）。
- 子 workflow 嵌套。

## Design

### 领域对象

| 对象 | 身份 | 生命周期 | 说明 |
|---|---|---|---|
| Workflow | `workflowId`（= DSL 文件路径/仓库内 id） | 定义态，git 版本化 | DSL 文件，一个文件一个 workflow |
| Node | `nodeId`（workflow 内唯一） | 静态定义；执行时产生节点实例 | start/end/agent/script/human |
| Edge | `(from, to)` | 静态定义 | 挂 JSONLogic `when` 条件 |
| Execution | `executionId`（ULID） | pending → running → waiting_human → terminal | 一次 workflow 运行 |
| Store | execution 级 | 随 execution 生命周期 | 跨节点 KV，仅节点显式写 |
| Trigger | 外部（CronJob row / API 请求） | 触发器自身生命周期 | 不在 DSL 内 |

### DSL schema

```jsonc
// workflows/oncall-triage.workflow.json
{
  "version": 1,
  "id": "oncall-triage",
  "input": { "issueUrl": "string" },          // trigger 变量声明（类型提示）
  "nodes": [
    { "id": "start", "type": "start" },
    { "id": "triage", "type": "agent",
      "agentId": "oncall-triage-agent",        // 或内联 { "model": "...", "prompt": "..." }
      "context": { "repo": "org/repo" } },      // 可选，节点级 context
    { "id": "risk", "type": "human" },          // 问题可由上游动态生成
    { "id": "notify", "type": "script",
      "runtime": "bun", "timeoutMs": 30000,
      "code": "export default async function run(ctx) { ... }" },
    { "id": "done", "type": "end", "status": "success" },
    { "id": "abort", "type": "end", "status": "failure" }
  ],
  "edges": [
    { "from": "start", "to": "triage" },
    { "from": "triage", "to": "risk",
      "when": { "==": [{ "var": "triage.output.severity" }, "high"] } },
    { "from": "triage", "to": "notify",
      "when": { "==": [{ "var": "triage.output.severity" }, "low"] } },
    { "from": "triage", "to": "abort",
      "when": { "==": [{ "var": "triage.output.severity" }, "critical"] } },
    { "from": "risk", "to": "done" },
    { "from": "notify", "to": "done" }
  ]
}
```

规则：

- **end 多出口**：end 节点带 `status` 标签，`success`/`failure` 是预置值，可自定义
  （如 `escalated`/`dismissed`）；execution 终态记录 `exit: <status>`。
- **无条件边** = 默认边；同一节点多条出边条件都真 → 并行 fan-out。
  **作者负责保证出边条件互斥**（如示例中的 high/low/critical），不互斥即有意并行。
- **agent 节点可选 `nextNode`**：output 里返回 `nextNode: "<nodeId>"` 覆盖静态边；
  指向的节点必须是已有边目标，否则视为路由错误（fail fast）。
- **JSONLogic 子集语义**（公开文档须自称子集，不照搬官方全部语义）：`==`/`!=` 为
  JSON 深比较（对象 key 序敏感）；`if` 仅严格三元 `[cond, then, else]`；`not`/`!!`
  接受数组或裸对象两种形式；`var` 支持 `"a.b"` 路径和 `["a.b", default]`。

### 节点类型语义

| 类型 | 语义 | 配置 |
|---|---|---|
| start | 入口；声明触发器传入变量 | `input`（类型提示） |
| end | 终结；execution 记录 `exit` | `status` |
| agent | coding agent 运行 prompt | `{agentId}` 或 `{model, prompt}`；可选 `context.repo`；可选 `nextNode` |
| script | 确定性程序（TS 函数） | `code` + `runtime: "bun"` + `timeoutMs`（默认 30000） |
| human | 问用户问题，前端渲染表单 | `question`/`form` 静态声明，或缺省（动态：取上游 output 的 `{question, form}`） |

**agent 节点**：`agentId` 优先——复用系统 agent 定义（model/skills/system prompt/
workspace），workflow 文件只存引用；内联模式用于不依赖系统 agent 的一次性任务。
派发走现有 agent-run 路径。

**script 节点**：不是裸 shell，是一个默认导出的 TS 函数，注入 `ScriptContext`：

```typescript
export default async function run(ctx: ScriptContext) {
  const { input, store, context, log } = ctx;
  await store.set("acked", true);
  log("notified", { url: input.issueUrl });
  return { sent: true };   // 返回值成为 output
}
```

注入能力（v1 最小集）：`input`（隐式合并输入）、`store`（get/set/delete，store 唯一
写入口）、`context`（`{executionId, nodeId, workflowId, repo?}`）、`log`（结构化日志
进事件流）。**不注入** model 调用和 exec——agent 管智能，script 管确定性程序，
`fetch`/文件系统 Bun 原生可用。

**human 节点** = ask-user 能力（Claude Code `AskUserQuestion` 式）：

- 问题两个来源：DSL 静态声明 `question` + `form`；或**动态**——上游 agent 节点输出
  结构化载荷 `{ question, form: {...} }`，human 节点渲染它。动态模式是核心。
- 前端收到 `human_task_requested` 事件后按 form schema 渲染表单并收答案；
  提交值 = human 节点 output，沿边流向下游（表单字段值可直接进 JSONLogic 条件）。
- 字段类型 v1：`string`/`textarea`/`number`/`enum`/`date`/`boolean`。
- 超时：`timeoutMs` 可配，超时走 failure 出口（v1 不做超时默认值）。
- 传输层复用现有 HITL 管道模式，但用**新事件类型**（不复用 approve/deny 语义）：
  `human_task_requested`（executionId/nodeId/question/form）+ resolve 端点。

### 数据流

- **全局合并**：下游 input = store 快照 + **全部已完成节点** output（非仅上游），按
  完成序、后完成覆盖先完成；引擎记录每个 key 的 provenance（哪个节点写的）。并行
  分支的 output 会互相可见——作者需保证 key 命名不撞（provenance 可辅助排查）。
- **边条件求值域**：仅**来源节点（from）的 output + store**，不注入其他节点的
  output。要引用更早节点的值，须由来源节点显式写进 store 再读。
- **节点 context**：每节点实例独立——`{executionId, nodeId, workflowId, repo?}` +
  解析后的 input + 节点内 scratch。
- **store**：execution 级 KV，仅节点通过 `ctx.store.set` 显式写；沿边的是"结果"，
  进 store 的是"共享状态"；每次写入是事件流一条记录。

### 执行引擎

- 生命周期：`pending → running → waiting_human → terminal(exit: success/failure/custom)`。
- 事件流（SSE，对齐 agent-run 现有模式）：`execution_started`、`node_started`、
  `node_completed`、`node_failed`、`store_write`、`human_task_requested`、
  `execution_terminal`。
- 并行：AND-join——节点等所有入边完成才执行。
- **路由固化**：源节点完成瞬间由引擎算出 routed targets 并固化进 CompletionRecord；
  之后任何节点的 store 写入都**不能**翻转已固化边的真值。
- **失败语义**：节点失败（重试耗尽/超时）**不参与图路由**——shell 直接以 failure
  出口终结 execution（记 `node_failed` 事件），不伪造 output、不走控制字段。
- **首 end 即终**：任何一步有 end 节点 ready 即终结；多个 end 同时 ready 时按节点
  定义序取第一个；在途兄弟分支由 shell 发 cancel。并行分支应汇合后再终结。
- **stuck 检测**：shell 在"无 ready 且无在途节点"时判 stuck → failure 出口。
- human 挂起/恢复：waiting_human 态持久化，恢复后从该节点继续。

### 触发器（外部绑定）

- **cron**：`CronJob` 增加 target 判别——`{type: "agent", agentId}`（现状）或
  `{type: "workflow", workflowRef}`；workflow 分支 fire 一个 execution。复用现有
  Bun.cron 调度器、single-flight 防重叠、超时/重试。
- **API**：`POST /api/workflow-executions` `{workflowRef, input}` → 异步
  `executionId` + SSE 订阅，形状对齐 agent-run API。`workflowRef` = workflow 仓库
  引用 + 仓库内路径（如 `{repo: "org/flows", path: "oncall-triage.workflow.json"}`），
  定位 DSL 文件。
- 变量经 start 节点 `input` 注入。

### 编辑器（v1）

- **画布只读渲染**：把 DSL 画出来（点选节点 → 右侧属性面板改配置）。
- **chat 侧栏**：LLM 生成/修改 DSL 补丁 → 用户确认 → git 提交（file-first 的自然
  结果：编辑 = commit）。
- v2：拖拽连线。画布难点在编辑手势不在渲染，v1 先只读 + chat 改图。

### 架构落点

- 新包 `packages/workflow`（`@chengchenccc/workflow`）：DSL 类型/解析/校验、JSONLogic
  子集评估、图拓扑（AND-join/路由固化/全局合并/provenance）、节点类型契约、编辑器
  基础（graph model + 分层布局）。纯逻辑 + 可复用 UI 基础，不依赖 backend/web。
- backend 新 feature：`apps/backend/src/features/workflow/`（六边形）——执行引擎的
  I/O 壳：agent 派发（复用 `AgentRunExecutionService`）、script 节点 Bun 执行、human
  节点 HITL 传输、store 持久化、事件流、HTTP；消费 `@chengchenccc/workflow` core。
- web：`apps/web` 新增 `/agentic-workflow` 路由页面，消费 `@chengchenccc/workflow`
  的编辑器基础 + 画布渲染。
- DSL 文件存于 workflow 仓库（`*.workflow.json`），与节点操作的"目标仓库"分离。

## Error handling

- 节点失败重试耗尽 → shell 直接以 failure 出口终结（不走图路由），execution 终态持久化。
- stuck（无 ready 且无在途节点）→ failure 出口。
- `nextNode` 指向非边目标 → 路由错误，fail fast（记 node_failed + failure 出口）。
- store 写入不丢：每次写是事件流记录，可回放。
- human 超时 → failure 出口。
- 触发器防重叠沿用 cron 现有 single-flight；API 幂等靠 executionId。

## Testing

- DSL 解析/校验/JSONLogic 子集评估：单测。
- 引擎：scripted fake agent（复用 echoModel/fake 工具模式），覆盖分支、并行 AND-join、
  全局合并 provenance、store 显式写、nextNode 覆盖、路由固化、首 end 即终、失败出口。
- human：复用 HITL 测试模式（approval 管道镜像）。
- 集成：cron fire → execution → agent/script/human → terminal 全链路。
- 编辑器：DOM 断言（沿用 headless Chrome 模式）。

## 默认决策清单（讨论中直接默认，可改）

1. DSL 文件名约定 `*.workflow.json`。
2. 节点失败统一走 failure 出口，v1 无 per-node 失败边。
3. script 节点默认 `timeoutMs: 30000`。
4. human 超时走 failure 出口，不做超时默认值。
5. 路由在源节点完成时固化，store 后续写入不翻转已走边。
6. 首 end 即终，多 end 同 ready 按节点定义序；在途兄弟取消。
7. 隐式合并为全局合并（全部已完成节点 output），作者避免 key 相撞。
8. 边条件求值域 = 来源节点 output + store。
9. 节点失败不走图路由，shell 直接 failure 出口终结。
