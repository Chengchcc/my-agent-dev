# ADR 0011: Web 信息架构重组：Work / Chat / Team 三级心智，Issue 于前端退役由 Loop 承接

> ✅ **已实施(2026-08-13)**：Work/Chat/Team IA 已上线(apps/web NavRail 三级结构)，Issue 页面退役由 Loop 承接。本文档从提案转为实施记录。

## 状态

Implemented(was Proposed)

> 🔄 部分演进（2026-09-03）：Team 子树：`/team` 现为 Team overview（agent 卡片网格
> + needs attention），agent 详情移至 `/team/[agentId]`，`/team/agents` 前缀退役
> （`next.config` 重定向）。本文「agent id 撞名静态段的路由劫持」前提经核实不成立：
> HTTP create 不接受客户端 id，agent id 只能是 ULID 或 bootstrap 常量（`"default"`），
> 不会等于 skills/mcp/knowledge/projects 静态段。

## 上下文

Web 控制台（`apps/web`）的信息架构是**按后端模块生长出来的**，不是按用户意图组织的。侧边栏 `NavRail` 当前把入口平铺成四组：`Workspace`（Agent 列表）、动态 `Conversations`、`Navigate`（Issues / Projects / Schedules / Skill Packs）、`Operations`（Observability / Loops）。这套结构有三类结构性问题：

### 两个产品卖点被拆散、强弱错位

产品有两条并列的价值主线：

- **在场协作**：人和多个 Agent 在同一对话里 `@mention`、实时双端（Web + Lark）同步。这是日常入口，但**不是差异化**：聊天类产品都有。
- **离场托付**：Loop 定时自主"发现 → 生成 → 独立验证 → 人在闸门"，把三步证据链摆到用户面前等待拍板。这是**护城河**：别的聊天产品给不了"你不在的时候 Agent 把活干完并自证"。

但当前 IA 把 `Loops` 塞进 `Operations` 组、和监控混在一起，等于把最强的差异化卖点降格成运维附属品。用户进门第一眼是"选一个 Agent 开始聊天"，而不是"有几件事等你拍板"。

### 同一件事被拆成多个平级概念（概念债）

`docs/architecture/design-philosophy.md` 的三条最终准则是"统一本体，不复制语义；暴露业务，隐藏机制；边界要硬，概念要少"。当前 IA 违反第三条：

- `/cron`（UI 名 Schedules）、`/loops`、`/issues` 三个平级路由都在做"定时 + 开关 + 运行 + 产出工作单元"，语义高度重叠。实际上 **cron 只是 Loop 的一个触发字段**（`cron_job.cronExpr`），**Issue 是一种工作单元**：它们是 Loop 的属性和产物，不该各自当一级路由。
- `/ops` 与业务并列成一级 tab，但可观测性本质是"贴着每个业务对象翻背面看证据"，不是独立领域。

### URL 与语义脱节、深链孤岛、复制粘贴残留

- `NavRail` 里 **`Loops` 条目重复渲染两次**（`NavRail.tsx:289-301` 与 `:302-313`，其中 `:302-313` 无 tooltip、`isActive` 误判），是明显的复制粘贴 bug。
- `/ops/agents`、`/ops/sessions`、`/ops/surfaces`（及各自 `[id]` 详情）在侧边栏**无任何入口**，只能靠组件内链接进入，是深链孤岛。
- 路由名与 UI 标签不一致：`/cron` 叫 "Schedules"，`/ops` 叫 "Observability"。
- cron 卡片、loop 的 "Run History" 都跳 `/conversations/{cronJobId 或 loopId}`，把非 conversationId 当 conversationId 用，语义混淆。
- 新建会话时人类成员 `userRef: "__legacy__"`（`NavRail.tsx:123` 等），过渡占位仍在生产路径。

### 关于"Issue 已被 Loop 取代"的事实澄清

产品决策是"Issue 由 Loop 承接、前端退役"。但**代码现状并非如此**，需在本 ADR 里诚实记录，避免后续实现基于错误前提：

- Issue 后端仍完整存活并接线：`apps/backend/src/app.ts` `.use(issues)`、`main.ts` 实例化 `createIssueService` / `sqliteIssueAdapter` / `issueRoutes`，drizzle `issue` / `issue_event` 表仍是 schema 核心，orchestrator reactor 仍消费 Issue。
- Issue Web 仍完整接线：`/issues` 页 + `IssueKanban` + `useIssue*` hooks + issue SSE 通道；`NavRail` 仍有 Issues 入口。
- Loop **不消费 Issue**：`loop-step.ts` 全程不 import issue，Loop 的 item 来源是自由字符串 `source`，item 状态持久在 `loop_item` / `loop_budget` 表。Loop 是独立子系统，不是 Issue 的下游。

因此本 ADR 的裁决是**产品方向的落地决策**，而非对现状的描述：**Loop 已作为并列一等功能落地，本 ADR 决定在前端（Web IA 层）退役 Issue、由 Loop 承接工作单元语义**；后端 Issue 表与服务的物理下线是独立的后续迁移，不在本 ADR 的前端 IA 范围内强制同步执行。

## 决策

**把 Web 信息架构从"模块地图"翻译成"用户意图地图"：收敛为 3 个一级心智 + 1 个低调系统区。**

```
WORK  —— 把活托付出去 / 看活干得怎么样   （承接 Loop；吸收 cron、issues 的工作单元语义）
CHAT  —— 和 Agent 在场协作               （以会话为根，Agent 是会话成员）
TEAM  —— 管理我的 Agent 同事             （Agent 身份/记忆/能力/就绪；Skill Packs、Projects 归此）
SYSTEM—— 系统健康与全局检索（低调，给运维，不占一级心智）
```

用户脑子里只需装三个词：**Work（托付）/ Chat（协作）/ Team（同事）**。现在的 issues、cron、loops、ops、skill-packs、projects 六个平级概念，全部归位为这三者的内部结构或产物。这直接落地设计哲学的"边界要硬，概念要少"与"暴露业务，隐藏机制"。

### 一件事一个家

同一个领域对象只在一个地方被创建、被查看、被追溯。Loop 的工作单元（item）、运行历史、证据链、审批，全部收在 `/work` 内部；不再散落到 `/issues`（另一套看板）、`/cron`（另一套定时列表）、`/ops/sessions`（另一套执行事实）。

### 可观测性是业务对象的"背面"，不是并列 tab

面向**单个对象**的执行事实（session / span / attempt）**下沉**到它所属的 Chat 会话或 Work 详情页里，在哪产生就在哪看，消灭深链孤岛。面向**全局**的健康与检索**上收**到 `/system`。`/ops` 作为一级入口取消。

### Issue 在前端退役，Loop 承接工作单元

`/issues` 路由、`IssueKanban`、"New Issue" 写入口从 Web IA 中移除。"一件需要 Agent 完成并经人审的工作"这一语义，统一由 Loop 的 item 表达。后端 Issue 表可暂留为只读/停用（物理下线是独立迁移），但**前端不再提供 Issue 的创建与看板入口**。

### 目标路由树

```
/                          落地页 = Work Today（不再 redirect 到 /agents）
/login

# ① WORK（承接 Loop）
/work                      Today：待我拍板的 Review Queue（awaiting_review 的 item）
                           + 今日运行/预算/异常概览，一屏看全
/work/[loopId]             某条 Loop 详情：item 列表 + 选中 item 的
                           Generator→Evaluator 证据链 + 人审动作
/work/[loopId]/runs/[runId] 单次运行的执行事实（下钻 span，收编原 /ops/sessions/[id]）
/work/new                  自然语言描述意图 → 系统生成 .loop 配置并预览（不暴露 cron/skill 语法）

# ② CHAT（以会话为根）
/chat                      会话总览：跨 Agent 最近会话（不再"先选 Agent 再看会话"）
/chat/[conversationId]     会话画布（主协作区），成员/busy/awaiting-approval 内联

# ③ TEAM（Agent 同事）
/team                      Agent 花名册：身份 + 就绪状态（合并原 /ops/agents）
/team/agents/[agentId]     单 Agent：Persona & Memory + 能力(Skill Packs) + 最近运行
                           （agent 详情住在 /team/agents/ 前缀下——与 /team/skills、/team/mcp、
                           /team/knowledge、/team/projects 平级段不再同层竞态,agent id
                           撞名静态段的路由劫持风险消除）
/team/skills               Skill Pack 分发（能力是团队资产）
/team/projects             Project 作为工作归属域

# ④ SYSTEM（低调）
/system                    Surface 接入健康 + 全局 trace 检索（收编 /ops/surfaces + 全局可观测）
```

### 与 Loop 代码词汇对齐（ADR 用词须与实现一致）

- Loop 不建独立表，复用 `cron_job` 行 + `loop_config_path` 列判定（`GET /api/loops` = cron 列表过滤 `loopConfigPath != null`）。
- item 步骤 `ItemStep`（`packages/loop/src/types.ts`）：`triaged | fixing | verifying | awaiting_review | resolved | inbox | promoted`。
- Evaluator verdict：`PASS | REJECT | ESCALATE`。
- 人审动作（`POST /api/loops/:id/review`）：`approve | reject | promote | retry | dismiss`。
- item 状态持久在 `loop_item` / `loop_budget` 表（非 STATE.md，STATE.md 已降级为导出物）。

`/work` 的 "Review Queue" = 所有 `awaiting_review` 的 `loop_item`；"证据链" = item 的 Generator 产出 + Evaluator 的 `VERDICT.md`；"拍板" = 调 review API 的五个动作。ADR 不引入任何新领域名词。

## 后果

- **导航收敛**：一级入口从 6~7 个降到 4 个（Work / Chat / Team / System）。产品故事"在场协作 + 离场托付"在导航栏上一眼可读。
- **默认落地页改为 `/work`**：进门第一眼是"有 N 件事等你拍板"，把差异化卖点摆到 C 位；根路由 `/` 不再 redirect 到 `/agents`。
- **Chat 以会话为根**：`/chat` 不再要求"先选 Agent"，符合"多方对话"本体（Agent 是会话成员而非会话的根）；原 Agent→Threads→Conversation 三跳动线缩短。
- **可观测性下沉 + 上收**：`/ops` 一级入口取消；单对象执行事实进入 `/work/[loopId]/runs/[runId]` 与会话详情；全局健康进 `/system`。`/ops/agents`、`/ops/sessions`、`/ops/surfaces` 三个孤岛路由被收编或重定向，深链孤岛消失。
- **Issue 前端退役**：`/issues`、`IssueKanban`、`useIssue*` hooks、"New Issue" 入口、issue SSE 通道从 Web 移除；`NavRail` 的 Issues 入口删除。后端 Issue 表/服务的物理下线列为独立后续迁移（本 ADR 不强制同步）。
- **历史包袱清理**：删除 `NavRail` 重复的 Loops 条目；清理 `userRef: "__legacy__"` 生产占位；统一路由名与 UI 标签（不再有 `/cron`→"Schedules"、`/ops`→"Observability" 的脱节）；cron 卡片/Loop Run History 不再把 cronJobId/loopId 当 conversationId 跳转。
- **不做的事**：本 ADR 只重组前端 IA 与路由，不改后端 Loop/Cron 的领域模型与 API 契约；后端 Issue 物理下线、`__legacy__` 在后端的清理属独立迁移。
- **迁移成本**：路由重命名需要一批重定向（旧 URL → 新 URL）保证外链不断；`NavRail`、`AppShell`、各 page 的 import 路径需要跟随目录调整。具体逐文件步骤留待配套 spec 与后续 plan。

### 与既有 ADR / 文档的关系

| | 现状 | 本 ADR |
|---|---|---|
| 一级入口 | 6~7 个平级（含 Issues/Cron/Loops/Ops 分裂） | 4 个（Work / Chat / Team / System） |
| Loop 定位 | 埋在 Operations 组 | 升为一级 `/work`，默认落地页 |
| Issue | `/issues` 全功能看板 + 写入口 | 前端退役，Loop item 承接 |
| Cron | `/cron` 独立列表 | 归并为 Loop 的触发字段，无独立路由 |
| 可观测性 | `/ops` 一级 + 3 个孤岛子路由 | 单对象下沉 detail 页、全局上收 `/system` |
| 会话入口 | Agent→Threads→Conversation 三跳 | `/chat` 以会话为根 |

## 关联

- [ADR 0008](./0008-collapse-harness-invocation-layer.md) — 塌缩 harness 调用层（后端同源"减概念"思路）
- [Loop PRD](../superpowers/plans/loop-engineering.md) — Loop 生命周期、文件模型、Phase 规划
- [设计哲学](../architecture/design-philosophy.md) — 暴露业务、隐藏机制；边界要硬、概念要少
- 配套 spec：`docs/superpowers/specs/2026-07-07-web-ia-work-chat-team.md` — 路由映射表、重定向清单、退役步骤、验收标准
