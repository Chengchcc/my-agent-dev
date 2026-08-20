# ADR 0025: Loop 执行 = Workflow 一等模型

## 状态

Accepted(2026-08-20)

## 背景

Loop 的"生成/评估"曾是两个独立 Agent 角色(loop-generator / loop-verifier),通过
`generator/evaluator` 双模型 + `.workflows/loop.js` meta 写回链执行:

```
loopStep → seed 硬编码 workflow 脚本(meta 携带 item 状态)
  → 外层 generator agent 用 workflow_run 工具执行脚本
  → 模型把 verdict 写回 .workflows/loop.js 的 meta block
  → 后端 extractLoopWorkflowMeta + validateLoopMetaPatch → 状态机
```

问题:
1. **角色层是历史遗留**——fix/verify 的真正逻辑已经在 workflow 脚本里(子 agent),
   外层 generator 只做"执行脚本 + 搬运 verdict",却保留了自己的 skill 与 systemPrompt。
2. **meta 写回脆弱**——模型必须用 write tool 改脚本里的 meta,产物是"文件状态"
   而非"run 返回值",解析/校验链复杂且易碎(Bug 3/Bug 4 都源于此)。
3. **配置与执行错位**——LOOP.md 的 generator/evaluator systemPrompt 约束的是外层
   agent,而真正干活的是脚本内子 agent;验收(acceptance)没有进入执行。
4. **无任务分类、无延期、无主动健康检查**——所有 item 同一 prompt;阻塞项烂尾;
   active run 坏死只能等下次触发撞上。

## 决策

### 1. Workflow 是唯一执行单元,删除 generator/verifier 角色

- `renderLoopWorkflow(item, cfg)` 渲染每 item 的 workflow 脚本:
  `fix` 子 agent(按 goal/action/taskClass 渲染)+ `verify` 子 agent(按 acceptance/
  verifyCommands 渲染),脚本 `return { verdict, evidence }`。
- `BackendRunInput.workflow` = 脚本直接执行(vm sandbox,子 agent 与主 loop 同构),
  返回值经 `BackendRunOutcome.workflow.value` 进状态机。
- 删除:外层 generator prompt、meta 写回链、`extractLoopWorkflowMeta`、
  `validateLoopMetaPatch` 消费、`loop-generator`/`loop-verifier` skill。

### 2. LOOP.md 契约(workflow-first,旧格式不兼容)

```
projectId / agent / model / acceptance / safety / budget
workflow:
  fixPrompt?      # 缺省由 goal/action/taskClass 渲染
  verifyPrompt?   # 缺省由 acceptance/verifyCommands 渲染
  verifyCommands? # 结构化验收命令清单
```

- 单一 `model`(子 agent 共享);删除 `generator/evaluator` 双段与 `gen≠eval` 约束。
- 旧格式(generator/evaluator)不再解析——**显式不兼容**。

### 3. 评估硬化

- `verifyCommands` 存在时,verify 子 agent 被强制"逐条执行命令并把完整输出贴进
  evidence;某命令无输出 = 未验证 = 必须 REJECT"。
- PASS 且 evidence 为空 → reducer 路由 inbox(已有 gate),人工兜底。

### 4. taskClass + defer

- `ItemState.taskClass`(bugfix/feature/refactor/research/review/chore)驱动差异化
  fix 指导(renderLoopWorkflow 按类注入)。
- `ItemState.defer{reason, until?, after?}`:`DEFER/UNDEFER` action;TICK 跳过 defer
  项,`until` 到期(`opts.now`)或依赖 resolved 自动恢复。
- 持久化:loop_item 表 `task_class`/`defer` 列(迁移 0036)。

### 5. 恢复分层

| 层次 | 机制 |
|---|---|
| workflow 级 | 子 agent 失败标记 `ok:false` 不崩脚本;verify 命令失败 → REJECT |
| loop state 级(主动) | **Loop Doctor**:定时巡检 zombie run(abortStaleRun 释放 branch)、
  stale item(run 已 terminal 但 item 卡 fixing/verifying → ESCALATE inbox)、
  deferred_due(到期 UNDEFER);启动补扫 + 每 5 分钟 + 手动 `POST /doctor` |
| loop state 级(预防) | cron 超时 → `AbortController.abort` → loopStep 停止 live run,
  branch 立即释放(不再制造新僵尸);`withTimeout` 兜底卡死 |
| 执行层 | `runTimeoutMs` watchdog 最后防线 |

### 6. cron 结合与发现闭环(规划)

- Loop = cron_job(loopConfigPath);fireLoop → loopStep(TICK),per-loop 锁串行。
- 发现闭环:loopStep TICK 前 `auto-triage`——扫项目 repo mirror 信号(新提交 /
  agent 分支待合并产出)→ triage workflow → ADD_ITEM(幂等)。触发:cron 到点 +
  手动 `POST /triage`;webhook 留 v2。

## 后果

- 删除 `loop-generator`/`loop-verifier` skill;`loop-triage` 保留(发现环节)。
- `LoopConfig` 旧格式(generator/evaluator)解析返回 null;既有 loop 需重写 LOOP.md。
- `BackendRunInput/Outcome.workflow` 是 oma-only 协议字段;CLI backends 忽略。
- 子 agent 共享单一模型(成本高于双模型),per-agent model 留待 `agent()` 扩展。
- 创建闭环(四要素 + verifyCommands + 智能表单)与 doctor/超时取消已落地;
  发现闭环(ADR 内规划)待实现。

## 关联

- ADR 0019(CLI session 双轨)、ADR 0020(workspace 桥接)——执行事实仍归 child,
  workflow 是 oma 自研 child 的一等执行输入。
- docs/architecture/roadmap/future-work.md(自主记忆/遥测等)不受影响。
