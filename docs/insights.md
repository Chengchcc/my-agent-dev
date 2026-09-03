# 项目 Insight（证据驱动）

> 定位：本文只回答「为什么」并指向行动。现状描述见 [CONTEXT.md](../CONTEXT.md)，
> 待办清单见 [future-work.md](./future-work.md)——三份文档不混用。
> 基线：2026-08-31 HEAD（8f200eb4），证据窗口 2026-08-05 起 532 commits。

## 第一步对齐：目标、问题、指标

- **项目目标**（README/ADR 推导）：单人可运维的多 Agent 团队运行时——可靠执行（不掉消息、终态原子）+ 可编排（Workflow）+ 双端可见。
- **本项目的「用户」是谁**：① repo owner（决策者 + 唯一运维者 + 产品最终用户，ADR 0026 单用户定位）；② 会话 agent（oma child 与在仓库里工作的 coding agent——文档与契约的消费者）；③ 未来表面的其他使用者（当前不存在，不作为 insight 对象）。
- **关键不确定性**：迭代为何持续高 fix 率？新能力如何避免建成即删？agent 协作质量靠什么保障？
- **决策目标**：下一个周期投入哪里——契约加固 / 冒烟 workflow / schema 清扫。
- **可持续度量指标**（均可由 git + audit 脚本产出）：fix:feat 比、跨边界 fix 占比、死概念残留数、真实 E2E 冒烟通过率、audit:docs / audit:contracts 红绿。

**证据来源与局限**：全部来自 repo 考古——git 统计、commit 主题、ADR、memory 教训。无用户访谈、无 A/B（单人项目）。因此可信度上限为「较高可信」，标注在每条末尾。

---

## I1 跨进程/跨表面接线是缺陷的主要来源，领域逻辑不是

**我们观察到** 532 commits 中 115 个 fix（fix:feat ≈ 0.43），高度集中在边界：web 23、workflow 14、backend 12、ai 8（另 3 个组合 scope）；24 个 fix 主题含 sse/token/url/poll/contract/prop 等边界词；而 `packages/workflow` 纯域引擎（graph/engine/json-logic）同期几乎零 fix。

**证据是** 定量分布（上），加上三类定性案例：
- `fix(ai)` 的 11 个提交全部是外部 API 协议边缘——`keep assistant text and tool images in provider adapters`（流式文本丢弃）、`clamp max_tokens to provider gateway cap`、`split assistant tool_result blocks`、`merge consecutive tool messages`、YAML 边缘解析、Bearer 占位符；
- workspace bridge 写 `.mcp.json` 裸 URL → child SSEClientTransport 404 → MCP 挂载失败 → 全部注入工具不可见且 native 兜底**静默降级**（08-26 真实 E2E 发现）；
- WorkflowCanvas optional prop 链断裂（组件解构漏名 + 内部派生函数 4 个调用点没传）——typecheck/lint 全绿，功能静默失效数月。

**这并不是因为** 领域设计薄弱，**而是因为** 类型系统在每个进程边界退化为 stringly 媒介（JSONL/SSE/env/URL），optional prop 的断裂在 TS 里没有检查点；单测用 echoModel/fake 验证领域语义，天然不覆盖 wire 语义。

**这会导致** 新表面（端/backend/节点类型）的边际成本主要花在接线验证而非功能；每个边界 bug 的发现成本被推到真实运行时。

**因此存在的机会是** 把仓库里已被证明的契约模式推广到薄弱边界——`rpc-*.jsonl` fixture 契约（oma↔adapter 已有）、`audit:contracts` 零容忍（web 已有）、`typedSource`（SSE 已有）→ 补 `.mcp.json` 生成物的 URL/token 送达校验、workflow SSE 事件 round-trip 测试。预计影响：跨边界 fix 占比、新 backend 接入成本。

**可信度**：较高可信（多源定量 + 案例；未做分群归因）。

## I2 已「闭环」的功能仍被整体替换——删除成本才是架构决策的真实成本

**我们观察到** Loop 自 07-02 开发，08-20 ADR 0025 宣布闭环（Doctor 巡检、defer、taskClass、verifyCommands 全落地），**08 天后（08-28，d35e7dd6）整体删除**，由 4 天前才诞生的 Workflow DSL 接管；同期 PluginTool.kind 建成数日内删除。

**证据是** git 时间线（loop 提交 07-02→08-20；workflow 提交 08-27→08-31；loop-step.ts 删除于 08-28）+ ADR 0025 自述（角色层历史遗留、meta 写回脆弱、配置与执行错位）。

**这并不是因为** 闭环做得不完整，**而是因为** 闭环验证的是「状态机能不能跑」，没有验证「产品心智是否匹配」——owner 真正要的是可视化节点图（agent/script/human + Artifact），不是 STATE.md 文件态状态机；在错误抽象上叠功能（Doctor、defer）实际是在增加未来的删除成本。

**这会导致** 前期正确性投资中，只有落在**正确的抽象边界**上的部分被保留（如 source-fetch 基座）；其余随替换归零。

**因此存在的机会是** 新能力先落「最小公共基座 + 真实使用验证」再扩展——source-fetch 是正例（薄抽象、两个消费方立即复用）；DSL 落地 4 天 62 commits 的速度也说明选对了心智。预计影响：建成即删率、返工 commits。

**可信度**：较高可信（事后归因，单项目样本）。

## I3 文档是 agent 的运行时依赖；腐化快于人工维护，自动审计有效但覆盖不足

**我们观察到** 532 commits 期间三份 agent 必读文档同时失真：AGENTS.md 指向不存在的 `features/loop`、README 列 9 个已删包、knowledge-pack 教已删的 `InterruptSignal`；修复消耗一个完整会话（199+/159-），且修复**过程中** `audit:docs` 当场抓到人工错误（表数 21 误写 22）。

**证据是** 上述 diff + audit 脚本行为 + 本会话以滞后 CONTEXT.md 为基线开展探索的事实。

**这并不是因为** 缺少文档习惯（75 个 docs commits、双读者结构齐全），**而是因为** 文档没有 CI 级对齐点——`audit:docs` 只查表数/链接/词汇，不查「提到的目录/包是否存在」；而 agent 会话无状态，文档是其唯一跨会话记忆，腐化直接变成每个新会话的探索浪费与误改风险。

**这会导致** agent 协作质量随仓库演进速度衰减；本次已实测一次「探索轮次浪费在确认 loop 无读者」。

**因此存在的机会是** 扩展 `audit:docs`：提取 AGENTS.md/README/CONTEXT.md 中的路径 token 与文件系统对账（目录/包存在性），红即挡。预计影响：文档审计从「抽样」变「零容忍」，agent 冷启动成本。

**可信度**：已验证（本次实测；「agent 产出质量下降」本身未量化）。

## I4 真实模型 E2E 验证稀缺且高杠杆——wire 层 bug 几乎只在真实运行暴露

**我们观察到** 08-26 两次真实 E2E 各暴露一个 fake 测试完全无法覆盖的缺陷（`.mcp.json` URL 404 导致注入工具整体静默不可见）；workflow 接入真实使用后 fix 集中爆发（schema retry、null terminalResult poll、typed sse contract、auto-title retry）。

**证据是** memory 两条 08-26 E2E 记录 + 近 10 天 `fix(workflow)` 主题 + roadmap 曾把「真实运行验证」标 P0 却长期排后。

**这并不是因为** 测试写得少（161 个测试文件），**而是因为** 单测验证领域逻辑，真实链路的失败模式在 wire 语义——URL 编码、token 送达、SSE 断连、模型输出不确定（schema 不合规、空 verdict）。

**这会导致** 「演示可用」与「实际可用」之间存在暗沟，且暗沟里的 bug 由最高价的人（owner 的真实使用）发现。

**因此存在的机会是** 用自己的 Workflow DSL 跑**定时真实冒烟**（真实模型 + 真实 spawn → 断言账本写入/工具事件回流/artifact 产出）——同时完成产品自验证与回归保护。预计影响：暗沟 bug 发现时点、冒烟通过率。

| I4 | 真实 E2E 稀缺且高杠杆 | 冒烟通过率 | 较高可信 | ✅ `bun scripts/smoke-workflow.ts` + `SMOKE_CRON` 定时自冒烟（2026-08-31） |

## I5 删除决策快，但收尾清扫不进同一变更（已闭环）

**我们观察到** Loop/CronJob 功能删除后，收尾清扫未进同一变更。

**证据是** 功能删除于 2026-08-28（d35e7dd6）；schema 表定义与 DROP 迁移（0042/0043）随该提交一并落地。残留仅 `db.test.ts` 的 Phase-6 保留 fixture 对 `loop_item`/`loop_budget`/`cron_job` 三表 INSERT+断言——该 fixture 只 apply 到 0020（当时表仍存在），是自洽的历史迁移测试，保留 loop 行正是为了验证“0020 只删 audit、不碰其他表”，不应清理。

**结论** 本洞察在核实后已闭环：schema 无死表，迁移链完整，fixture 有意保留。教训转给 I3：洞察文档自身的表述也要与代码对账（本条初稿曾误称“表仍在 schema”）。

**2026-09-03 增补（UI 暴露面变体，已闭环）** goal 引擎删除时暴露面一度残留为幽灵
（`goal-state.ts`、`ConversationGoalStatusBar`、`/goal` 路由、WorkSummary），至 2026-09-01
（9f2dd45e）才清扫干净。规则固化：**删功能必须同变更清扫全部产品暴露面——引擎、UI、
命令、HTTP 接口、文档是一个功能的多个影子，只删引擎会留幽灵。** 未来「空间」功能
频繁增删时，把该规则当作删除类变更的验收项（audit 检查或 PR 自查清单）。

---

## 汇总

| # | Insight 标题 | 影响指标 | 可信度 | 下一步 |
|---|---|---|---|---|
| I1 | 接线（非领域逻辑）是缺陷主要来源 | 跨边界 fix 占比 | 较高可信 | 推广契约 fixture/audit 到 .mcp.json 与 workflow SSE |
| I2 | 闭环≠正确，删除成本才是架构真实成本 | 建成即删率 | 较高可信 | 新能力走「最小基座+真实验证」路径 |
| I3 | 文档是 agent 运行时依赖，审计覆盖不足 | audit:docs 红绿 | **已验证** | 扩展 audit:docs 做路径存在性对账 |
| I4 | 真实 E2E 稀缺且高杠杆 | 冒烟通过率 | 较高可信 | ✅ `bun scripts/smoke-workflow.ts` + `SMOKE_CRON` 定时自冒烟 |
| I5 | 删除收尾（已闭环） | 死概念残留数 | 较高可信 | ✅ 08-28 已随 d35e7dd6 完成；fixture 有意保留 |

Owner 均为 repo owner（单人项目）。每条推进后回填验证结果与可信度升级。
