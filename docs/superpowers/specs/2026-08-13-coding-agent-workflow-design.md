# Coding Agent 动态工作流(workflow)设计

- 日期:2026-08-13
- 分支:`feat/coding-agent-workflow`
- 状态:设计已获批(问卷 + 四段设计 + loop 消费者方向)

## 1. 背景与目标

参考 Claude Code 的 dynamic workflow:模型把"大规模编排"写成脚本(或直接调用编排原语),运行时执行,会话/run 保持响应。目标:

1. **第一步(子代理原语)**:coding-agent 获得进程内大规模并行子代理能力——模型用工具扇出 N 个子代理并发执行、聚合结果。
2. **第二步(脚本运行时)**:模型把编排写成可读、可改、可重跑的 JS 脚本(`agent()` / `pipeline()` 原语),沙箱求值。
3. **loop 改造(首个消费者)**:backend 的 loop feature 重构为"bundled workflow + 产品薄控制面"——持久状态载入脚本 meta,纯 reducer 降级为 meta 写回校验器。

## 2. 已定决策(问卷结论)

| 决策点 | 结论 |
|---|---|
| 范围 | 两步走(先子代理原语,再脚本运行时) |
| 子代理能力 | 同模型 + 核心文件工具,共享 workspace(两个边界例外见 §3) |
| 触发方式 | 分阶段:先模型工具调用,后命令入口 |
| 进度呈现 | 事件上产品线(wire → backend SSE → 前端) |
| 持久化 | 脚本存 workspace `.workflows/`;run 状态不恢复 |
| 实现路径 | 方案 1:全进程内(child 内子代理 + 沙箱求值器) |
| loop 分层 | meta 载状态 + reducer 校验写回 + 产品薄控制面 |

## 3. 子代理运行时(第一步)

### 3.1 原语

```ts
runSubagent({ prompt, schema?, label? }) → { text, output?, usage }
```

- 每个子代理 = 独立 agent session:**同模型 + 同 core 工具,独立 store + 空上下文**(prompt 自带所需信息,不继承父对话——同 Claude Code subagent)。
- `schema?`:结构化输出契约,结束时按 schema 解析 `output`;解析失败则 text 携带错误。
- 子代理系统提示固定:"你是本次 run 的子代理,完成任务即返回结果文本,不要继续对话"。完成即停。

### 3.2 workflow 工具(模型调用)

```ts
run_workflow({ items: [{ prompt, schema?, label? }], concurrency? })
```

- 并发默认 4、上限 8;单个执行器实例总代理上限 **64**(一次 `run_workflow` 调用或一次脚本运行的累计 spawn;3.5G 机器的保守值;Claude Code 为 16/1000)。
- 聚合每个 item 的 `text` + `output` 进工具结果 → 主 loop 的普通 tool_result,自然进产品树/账本。
- 执行器暴露**预算钩子**(loop 消费需要,§6):spawn 前查询预算,耗尽即拒绝新子代理。

### 3.3 边界决策(与"同工具"的偏差及理由)

1. **子代理工具 = read/write/edit/bash/grep/glob**。排除 workflow 工具自身(防递归);排除 product tools(history/todo——并行子代理写 todo_write 互相踩掉 run 快照)。
2. **无插件**:子代理 session 不带 identity/task-guard/conversation-context 等插件(全是主 loop 语义),只带最小系统提示 + 工具。
3. **取消**:子代理继承 run 的 abort signal,主 run 停止时全部终止。

## 4. 事件契约

### 4.1 child 内部事件(`CodingAgentLoopEvent` 新增)

```ts
{ type: "workflow_started",         workflowId, label, agentCount }
{ type: "workflow_agent_started",   workflowId, agentId, label }
{ type: "workflow_agent_completed", workflowId, agentId, label, ok, error?, usage? }
{ type: "workflow_completed",       workflowId, ok, agentCount, totalTokens }
```

### 4.2 产品线(`CoreBackendEvent` 新增,与 child 1:1,payload 最小)

- 完整结果(每个 agent 的 text + 解析 output)**只走工具结果**回主 loop(进产品树/账本);事件只带进度元数据(label/count/usage)。
- 流转路径零新通道:child loop 事件 → 现有 envelope → RPC stdout → `mapRunEvent` 映射 → backend SSE fan-out → 前端监听。

### 4.3 明确决策

1. **无 stage 概念**(第一步是平铺扇出;第二步 A 的 `pipeline()` 引入阶段时再加 `stage` 字段)。
2. **子代理的工具事件不上线**(agent 级事件足够;钻取留后续)。
3. **事件不派生终态**:run 的 outcome 仍是唯一终态权威(沿用现有契约原则)。
4. **仅 coding-agent 后端**产生这些事件(claude/pi/omp 无 workflow;union 共享但其他后端永不 emit)。
5. 与 feat/agent-workspace 合并时,`CoreBackendEvent` union 两线都有新增,预期小冲突。

## 5. 脚本求值器(第二步 A)

### 5.1 形态

```ts
workflow_run({ script, args? })
```

脚本 = 带 top-level await 的 JS,只注入三个原语:

```js
const found = await agent("List every .ts under src/", { schema, label });
const audits = await pipeline(found.files, f => agent(`Audit ${f}`, { label: f }));
return audits;
```

### 5.2 沙箱边界

- **受限求值**:`node:vm` + 白名单 context(不用 `new Function` 裸拼,不加依赖)。只注入 `agent` / `pipeline` / `args` / 内置类型工具;`require` / `process` / `fs` / `fetch` 一律不存在——脚本本身无文件系统与网络能力(同 Claude Code 约束)。
- **超时**:脚本整体预算 60s,超时终止所有在飞子代理。
- **上限由执行器统一强制**(并发 ≤8、总代理 ≤64),脚本无法绕过。
- **错误**:脚本抛错 → 工具结果 isError + `workflow_completed(ok=false)`;已完成子代理结果丢弃(run 状态不恢复,已定)。

### 5.3 脚本来源与落盘

- 模型把脚本写到 workspace `.workflows/<name>.js`(可读、可改、可重跑)。
- `workflow_run` 接受 script 文本直接执行;重跑 = 读文件再调。命令入口 `/<name>` 是后续阶段。
- **执行器共享**:求值器的 `agent()` / `pipeline()` 直连 §3 的 `runSubagent` / `run_workflow`——事件、上限、预算钩子、取消全部复用同一通道,不重复实现。

## 6. Loop 改造(首个消费者)

方向:**loop = bundled workflow + 产品薄控制面**。持久状态载入脚本 meta,产品保留脚本永远不该有的东西。

### 6.1 状态表示

- workflow 脚本 = `meta`(每实例数据)+ `body`(纯逻辑,可重跑、可跨 loop 复用)。
- **meta 载 loop 状态**:item 列表 + 各 item 步骤(7 步)+ verdict + 预算累计。每次 step 后回写。
- 脚本文件落在 agent workspace(产品磁盘,持久)→ 状态跨 run/cron/崩溃存活;与"run 状态不恢复"决策不冲突(在飞代理照丢,落盘状态照存)。
- INBOX.md(待处理输入)保留为独立文件(跨来源写入,非脚本产物)。

### 6.2 产品控制面(脚本永远不该有的东西)

1. **meta 写回必须过纯 reducer 校验**(9 action / 7 step 转移不变式):模型不能自由写状态;`packages/loop` 的 reducer 从"产品编排器"降级为"meta 写回校验器",代码主体保留。meta 校验器与执行器预算钩子必须和 workflow 地基同批落地,否则 loop 改造悬空。
2. **评审门禁在调用之间**:workflow 的"无中途人工输入"约束不变;产品在两次触发间暂停等人工,不塞进脚本。
3. **预算闸在执行器**:workflow 执行器的子代理 spawn 处挂钩产品预算(64 上限 ≠ 预算);meta 里记预算是账本,不是闸。
4. **cron 触发 + git 回滚(step 间)+ 写锁**:照旧,全在产品。

### 6.3 收益

- generate → evaluate → 重试循环(现在每迭代两次产品 run)变成进程内脚本 `while` 循环:一个 spawn 替代 N 个,重试轮数脚本控制,item 生成并行扇出。
- loop 成为 workflow 地基的首个消费者;未来 cron 扫描、类 deep-research 命令复用同一能力。

## 7. 前端呈现

- **进度卡**(对话画布内,复用瞬时状态模式,同 tool chip/todo 面板):workflow 运行中显示 label、`N/M agents`、每个代理一行(status/label)、累计 tokens、耗时;失败代理标红 + error 摘要;`workflow_completed` 到达 → 折叠态(一句话汇总)。
- **状态与生命周期**:`useConversation` 加 `workflows: Map<workflowId, …>`,监听 §4 的 4 个 SSE 事件;卡片是瞬时进度(切会话/刷新即清)——持久真相 = 工具结果(产品树/账本)+ 模型合成的最终报告(现有渲染,零新组件)。
- 无新路由/页面(v1);`/workflows` 式命令中心留到命令入口阶段。
- **子代理钻取(v1 不做)**:卡片只到 agent 级。

## 8. 实施顺序

1. **Phase 1(子代理原语)**:`runSubagent` + `run_workflow` + 执行器(并发/上限/取消/预算钩子)+ §4 事件 + §7 前端进度卡。可独立验收:模型一句话扇出 20 个只读审计代理,前端看进度。
2. **Phase 2(脚本运行时)**:`workflow_run` + vm 沙箱 + `.workflows/` 落盘。可独立验收:模型写脚本 → 执行 → 重跑。
3. **Phase 3(loop 消费者)**:bundled loop workflow + meta 载状态 + reducer 校验写回 + 预算闸接线。验收:现有 loop 集成测试改造后全绿,行为等价 + 性能提升(每次迭代少一次 run)。

## 9. 风险

| 风险 | 缓解 |
|---|---|
| vm 沙箱逃逸 | 白名单 context + 无 fs/network 注入面 + 60s 预算;不引入 `new Function` 裸拼 |
| 并行写冲突(共享 workspace) | 分片靠编排(prompt 划分不重叠文件);执行器并发上限 8;v1 不做文件级锁,冲突由模型分片纪律兜底 |
| 子代理上下文成本(64 × 全上下文) | 子代理空上下文 + 最小提示;预算钩子(loop)与 64 上限兜底 |
| meta 校验与执行器预算钩子未同批落地 → loop 悬空 | Phase 3 的前置条件写进 Phase 1 验收(预算钩子随执行器落地) |
| 与 feat/agent-workspace 合并冲突 | 事件 union 两线新增,预期小冲突;workflow 不依赖 workspace 分支的 session-file/MCP mount |
