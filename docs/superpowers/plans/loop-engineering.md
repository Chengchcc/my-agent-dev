# PRD: Loop — 统一工作系统

## 1. 概述

### 问题陈述

my-agent-team 有两套工作系统：`/conversations` 对话，`/issues` Kanban。两套心智模型、两套 UI、两套执行引擎（[Orchestrator](../architecture/backend/orchestrator.md) + [ColumnConfig](../architecture/backend/orchestrator.md) vs. 裸 AgentSession dispatch）。工程师想做"每天早上检查 CI 失败，自动修简单的"，要么每天手动做，要么配 [CronJob](../architecture/foundations/cron-job.md) 触发裸 agent——没有 discovery 阶段、没有结构化输出、没有 verification 分离、没有 review queue。[Issue/Kanban 模型](../architecture/foundations/issue-workflow.md) 假设了 planner → developer → reviewer 的代码修复流水线，塞不进"给 issue 打标签""生成 release notes""提醒 stale PR"这些场景。两套系统不共享执行基础设施、UI 模式、概念模型。没有一个统一的概念来表达"需要做的工作"。

### 解决方案

Loop 是统一的工作概念。用一个模型取代 Kanban Issue 流程和裸 CronJob dispatch：**Loop 发现工作、执行、验证、暂停等人判断。** 手动工作池就是一个没有 discovery 的阶段和 schedule 的 Loop——人往里加 item，同一套 act/verify/judge 流水线照样跑。

> **MVP 阶段两套数据并存（已知代价）**：本 PRD 只把 `/issues` 从导航移除、Issue 表保持只读且**不迁移**（迁移列入 §9 待决问题）。因此「统一工作系统」在 MVP 是**入口统一、数据未统一**——底层仍有 Issue 表与 Loop 的 STATE.md 两处状态。下方「一个入口取代两个」指的是**用户可见入口**，不代表底层数据已收敛；真正的单一数据源要等 Issue 迁移工具（P2）落地。

### 成功指标

- **减少工作入口认知负荷**：用户从一个**可见工作入口**（`/loops`）取代两个（`/issues` + 散落的 CronJob 管理）——底层数据收敛见上方 MVP 说明
- **减少 triage 手动时间**：每天早上的 CI/issue/PR 检查从手动 15-30 分钟降到 review queue 审批 3-5 分钟
- **审批吞吐率**：用户在 review queue 中单次审批决策时间 < 60 秒（信息充分展示，不需要跳转外部工具）
- **零安全事件**：denylist 路径从未被自动编辑；auto-merge 非 allowlist 场景从未自动推送
- **预算可控**：因 bug 导致 token 超支的事件为 0（budget cap 机制兜底）

## 2. 背景与上下文

### 为什么是现在

- [AgentSession](../architecture/harness/harness.md) 已成熟——单次 agent 运行的重试、compaction、steering 都已稳定，作为 Loop 的 building block 到位
- [CronJob](../architecture/foundations/cron-job.md) 设计已锁定（`status: design`），提供了 cron 解析、`Bun.cron` 注册、超时、重试的完整调度层
- [progressive-skill plugin](../architecture/plugins/progressive-skill.md) 已就绪——但**需一处改造**：双域发现现在只认 global（`/global/skills/`）+ project（`/workspace/.claude/skills/`）两个 root，`.loop/skills/` 不在其中；Loop 启动时须把 `.loop/skills/` 追加为第三个 root（或映射进 project root），不是拿来即用
- [fs-memory plugin](../architecture/plugins/fs-memory.md) 提供 STATE.md 的**文件读写**基础设施——但它是纯读写、无锁、单前缀（默认 root `./memory/`），**不提供并发写的锁/合并**；STATE.md 的并发一致性须由 Loop 层自己兜（见 §7「并发与一致性」）
- 竞争对手和行业趋势（[Loop Engineering](https://addyosmani.com/blog/loop-engineering/)，2026-06；[loop-engineering 参考仓库](https://github.com/cobusgreyling/loop-engineering)）已验证此模式

### 战略对齐

与 my-agent-team 的产品目标一致：让 Agent 从"对话工具"进化为"工作系统"。`/conversations` 是对话面，`/loops` 是工作面。两者并列为产品两大支柱。

### 用户研究摘要

基于 loop-engineering 社区的反馈和 [Stripe Minions](https://www.howiai.tech/)（1,300 PR/周）等生产案例：
- 工程师每天早上 triage 消耗 15-30 分钟判断"什么值得处理"
- 最需要的自动化：CI 修复、PR 提醒、issue 分类、依赖更新（[loop-engineering patterns](https://github.com/cobusgreyling/loop-engineering/tree/main/patterns)）
- 最大恐惧：无人看守时代码被自动推送（auto-merge 必须默认 never）
- 最意外的发现：Evaluator 必须用不同 model——同 model 审查自己产出的代码通过率虚高（[Rajasekaran, 2026](https://www.anthropic.com/engineering/generator-evaluator)）

## 3. 用户故事

### 创建 Loop

**US1: 自然语言创建**
作为工程师，我想用自然语言描述我的自动化意图（"每天早上检查 CI 失败，自动修简单的"），这样我不需要学 cron 语法、skill 名称、安全配置。

验收标准：
- 输入框接受自然语言，回车后展示系统解读的配置预览（schedule、discovery 范围、generator/evaluator、safety、budget）
- 用户可逐项调整任何字段
- 确认后 `.loop/` 目录自动生成，CronJob 自动创建
- 配置预览中包含安全提示（"以下路径被加入 denylist：..."）

**US2: 手动工作 Loop**
作为工程师，我想创建一个没有 schedule 和 discovery 的手动 Loop，只靠我往里加 item，系统照样跑 generator → evaluator → 我审批，这样临时任务也能受益于同一套流水线。

验收标准：
- 创建时选 "manual" 触发模式，不填 schedule
- 手动 Loop 也有完整的 generator/evaluator 配置和安全约束
- 仪表盘上手动 Loop 和自动 Loop 并列显示，只有触发方式不同

### 仪表盘

**US3: Loop 仪表盘**
作为工程师，我想在一个视图里看到所有 Loop，每个显示等待审批的 item 数、今日 token 消耗相对预算的比例、上次运行时间，这样我不用点进去就知道哪些 Loop 需要关注。

验收标准：
- 卡片式布局，每个 Loop 一张卡片
- 卡片显示：Loop 名称、一句话意图、待审批数（红色 badge）、今日 token/预算、上次运行时间
- 支持暂停/恢复/删除操作
- 有"新建 Loop"入口

**US4: 手动触发**
作为工程师，我想手动触发一次 Loop 运行而不等下次 cron tick，这样编辑配置后可以立即验证。

验收标准：
- Loop 卡片上"Run now"按钮
- 点击后触发一次运行，仪表盘显示进度
- 运行完成后通知

### Review Queue（Loop 详情页核心）

**US5: 审批卡片展开**
作为工程师，我想看每个等待审批的 item 的完整证据链——原始发现、generator 的改动、evaluator 的判定——这样我可以做出知情的 approve/reject 决定。

验收标准：
- 卡片展示三步：Finding → Generator → Evaluator，每步可展开
- Generator 展开显示 diff（语法高亮）、修改的文件列表、attempt 计数
- Evaluator 展开显示：测试命令 + 实际输出、scope check 结果、截图（如有）
- 卡片底部三个操作：[Approve] [Reject] [Promote]

**US6: 一键审批**
作为工程师，我想一键 approve/reject 一个 item，这样审批不拖慢节奏。

验收标准：
- Approve：item 标记 resolved，从 queue 消失
- Reject：弹出反馈输入框（可选），提交后 item 标记 inbox
- Promote：弹出目标选择器（另一个 Loop），提交后 item 标记 promoted

**US7: 统一 Review Queue**
作为工程师，我要 review queue 是统一的视图，不管 item 从哪来（自动 Loop discovery、手动工作池、从另一个 Loop promote），这样不用在多个地方检查需要我判断的东西。

验收标准：
- Review queue 展示所有 Loop 产出的 awaiting_review item
- 每个 item 标明来源 Loop 名称

### 运行历史

**US8: 运行时间线**
作为工程师，我想看每个 Loop 运行的时间线——某次运行 discovery 发现了什么、修了什么、被拒了什么——这样我可以审计 Loop 的行为趋势。

验收标准：
- 时间线视图，每次运行为一个节点
- 展开节点显示当次运行的所有 item 及最终状态
- 支持按日期筛选

### 安全与成本

**US9: 预算保护**
作为工程师，我想给每个 Loop 设置每日 token 预算上限，达到 100% 自动暂停，达到 80% 告警，这样 bug 不会烧光配额。

验收标准：
- 创建时默认设置为保守值（如 200k tokens/day）
- 仪表盘卡片上显示预算使用进度条
- 达 80% 时卡片变黄，达 100% 时 Loop 自动暂停并通知
- **计数强一致**：「已用 token」是一个原子的读-改-写量，**不落在 STATE.md 这种非原子文件里**——必须走带锁/CAS 的 per-loop 计数（DB 一行 upsert 或进程内带锁 accumulator），否则 cron 与手动触发并发时两路各读旧值、各放行一轮，会冲穿 cap（见 §7「并发与一致性」）

**US10: 路径保护**
作为工程师，我想要路径黑名单强制执行——匹配 `.env`、`auth/`、`payments/` 的文件绝不修改——这样安全敏感代码永远不会被 auto-edit。

验收标准：
- 创建时 denylist 默认包含 `.env`、`auth/`、`payments/`、`secrets/`
- Evaluator 的 scope check 自动比对 denylist，触碰即 REJECT
- 安全事件记录到 run history
- **denylist 只增不减地合并**：intent→config 是非确定性 LLM 调用，可能漏配安全路径；翻译器**不得删除或覆盖默认 denylist**，只能在其上追加——用户预览时可加不可减默认安全项

## 4. 功能需求

### P0 — MVP 必做

- 自然语言创建 Loop（intent → config 翻译 + 预览 + scaffold `.loop/` 目录）
- 手动 Loop（trigger=manual，无 discovery，人加 item）
- Loop 仪表盘（列表、统计、暂停/恢复/删除、手动触发）
- Loop 详情页 review queue（item 卡片、证据链展开、approve/reject/promote）
- 运行历史时间线
- `loopStep()` 编排函数（discovery → generator → evaluator → human gate，STATE.md 持久）
- **per-loop 写锁**：cron / 手动触发 / review 三条入口都调 `loopStep()` 且都写 STATE.md，必须共用一把 loop 粒度的写锁串行化——CronJob 的单飞锁只护 cron 一条路，护不住手动/review（见 §7「并发与一致性」）
- **原子预算计数**：per-loop 已用 token 走带锁/CAS 计数，不落 STATE.md
- CronJob `loop_config_path` 列 + handler 集成
- `loopReducer()` 纯函数 + 测试
- 预算保护（daily cap，80% 告警 + 100% 暂停）
- 路径 denylist 强制执行（默认项只增不减合并）
- **并发上限**：`maxParallelFindings` 配置 + 进程级 AgentSession 池——**当前 harness 没有这个池，须新建**；缺它时单个多-finding Loop 会瞬时拉起大量 AgentSession 打满进程
- 已有 Issue 系统保持只读

### P1 — 第二版

- Evaluator 通过 MCP 操作浏览器（截图验证前端改动）
- Loop 运行 SSE 实时进度推送
- Post-run critique 展示和编辑
- 手动 item 添加 UI（手动 Loop 的"Add item"流程）

### P2 — 后续

- Loop 之间的 item 移动（从一个 Loop promote 到另一个）
- 多 Loop 协调（优先级、资源竞争处理）
- Loop Ready Score 展示
- 已有 Issue 数据迁移到 Loop

### 非功能需求

- **性能**：Loop 仪表盘加载 < 2s，review queue 卡片展开 < 500ms
- **安全**：denylist 路径零容忍；auto-merge 非 allowlist 零自动推送
- **可观测**：每次 `loopStep()` 调用记录到 checkpointer 的执行事实流
- **可恢复**：STATE.md 持久化确保进程重启后 human gate 不丢失状态

## 5. 设计与用户体验

### 导航结构

```
┌──────────────────────────────────┐
│  Sidebar                          │
│  ─────────                        │
│  💬 Conversations                 │
│  🔄 Loops          ← 新增        │
│  🤖 Agents                        │
│  📊 Operations                    │
└──────────────────────────────────┘
```

`/issues` 从侧边栏移除。`/loops` 成为工作和自动化的统一入口。

### 创建 Loop —— 对话式

```
┌─────────────────────────────────────────────────┐
│  Create Loop                                     │
│                                                  │
│  What should this loop do?                       │
│  ┌─────────────────────────────────────────────┐ │
│  │ 每天早上检查 CI 失败，自动修简单的              │ │
│  └─────────────────────────────────────────────┘ │
│                                                  │
│  ──────── Generated Config ────────              │
│                                                  │
│  Schedule    Daily 8:00 AM                  [✎]  │
│  Discovery   Read CI failures (24h)         [✎]  │
│  Generator   claude-sonnet-4                [✎]  │
│  Evaluator   claude-opus-4                  [✎]  │
│  Safety      Denylist: .env, auth/, ...     [✎]  │
│  Budget      200k tokens/day                [✎]  │
│                                                  │
│                        [Cancel]  [Create Loop]   │
└─────────────────────────────────────────────────┘
```

### Loop 仪表盘

```
┌──────────────────────────────────────────────────────────────┐
│  Loops                                                        │
│                                                               │
│  [+ Create Loop]                                              │
│                                                               │
│  ┌────── Morning Triage ──────────────────────────────────┐  │
│  │  "每天早上检查 CI 失败，自动修简单的"                     │  │
│  │                                                         │  │
│  │  Daily 8:00 AM  ·  Last: Today 8:03  ·  3 items        │  │
│  │                                                         │  │
│  │  ⏳ 2 awaiting review    ✓ 5 resolved this week         │  │
│  │                                                         │  │
│  │  ████████░░ 85k / 200k today                            │  │
│  │                                                         │  │
│  │  [Pause]  [Run Now]                          [View →]   │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌────── PR Watcher ──────────────────────────────────────┐  │
│  │  "每15分钟检查开放 PR，提醒 reviewer"                     │  │
│  │                                                         │  │
│  │  Every 15 min  ·  Last: 10 min ago  ·  0 items          │  │
│  │                                                         │  │
│  │  ██░░░░░░░░ 28k / 300k today                            │  │
│  │                                                         │  │
│  │  [Pause]  [Run Now]                          [View →]   │  │
│  └─────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### Loop 详情页 = Review Queue + 运行历史

```
┌────── Morning Triage ──────────────────────────────────────────┐
│  "每天早上检查 CI 失败，自动修简单的"                             │
│                                                                 │
│  [Review Queue]  [History]                                      │
│                                                                 │
│  ── Review Queue (2 awaiting) ──────────────────────────────   │
│                                                                 │
│  ┌─ f-1 ─────────────────────────────────────────────────────┐ │
│  │                                                           │ │
│  │  🔴 auth test flaky on timeout                            │ │
│  │  Source: CI run #4821  ·  Attempt 1/3                     │ │
│  │                                                           │ │
│  │  ── Generator ──                   [Expand diff ▼]       │ │
│  │  Modified: auth.test.ts (+2 lines)                        │ │
│  │                                                           │ │
│  │  ── Evaluator ✓ PASS ──           [Expand evidence ▼]    │ │
│  │  Tests: 12/12 green                                       │ │
│  │  Scope: auth.test.ts only                                 │ │
│  │                                                           │ │
│  │  [Approve]  [Reject...]  [Promote →]                      │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌─ f-3 ─────────────────────────────────────────────────────┐ │
│  │                                                           │ │
│  │  🟡 null deref in parser.ts                               │ │
│  │  Source: issue #92  ·  Attempt 2/3                        │ │
│  │                                                           │ │
│  │  ── Attempt #1 ──                                         │ │
│  │  Generator: modified parser.ts + 3 files (45 lines)       │ │
│  │  Evaluator ✗ REJECT: scope drift — touched utils/format  │ │
│  │                                                           │ │
│  │  ── Attempt #2 ──                                         │ │
│  │  Generator: modified parser.ts only (15 lines)            │ │
│  │  Evaluator ✓ PASS: tests 8/8, scope clean                │ │
│  │                                                           │ │
│  │  [Approve]  [Reject...]  [Promote →]                      │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ── Recently resolved ────────────────────────────────────    │
│                                                                 │
│  ✓ f-2  stale dep — APPROVED  (today 8:03)                    │
│  ✓ f-7  lint warning — APPROVED  (yesterday)                  │
│  ✗ f-4  build flake — REJECTED → inbox  (yesterday)           │
└─────────────────────────────────────────────────────────────────┘
```

### 边界情况与错误状态

- **Discovery 空结果**：显示"Nothing found this run"，不崩溃
- **Generator 产出空 diff**：Evaluator 判 REJECT，item 进 inbox
- **Evaluator 无法运行测试**（环境问题）：判 ESCALATE，item 进 inbox 并附带说明
- **Budget 耗尽**：Loop 自动暂停，仪表盘显示红色暂停状态 + 原因，所有未处理 item 进 inbox
- **CronJob 被删除但 Loop 还在**：Loop 降级为 manual-only，仪表盘显示警告
- **STATE.md 损坏**：`loopStep()` 解析失败时写 error event，跳过本轮，不崩溃
- **同一 item 重复发现**：通过 source ref 去重（同 CI run # 或 issue #），已在 STATE.md 中的不再新增
- **并发手动触发 + cron 触发**：CronJob 的单飞锁确保同一 Loop 不同时跑两轮

## 6. 系统模型

### 分层架构

```
┌──────────────────────────────────────────────────────────┐
│  L6 Surfaces (apps/web)                                   │
│  /loops 仪表盘 + 详情页（review queue + 运行历史）         │
│  消费 Loop SSE 事件，展示 item 证据链                      │
├──────────────────────────────────────────────────────────┤
│  L5 Backend (apps/backend)                                │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Loop HTTP   │  │ CronScheduler │  │ loopStep()     │  │
│  │ CRUD +      │  │ Bun.cron →    │  │ 读 STATE.md    │  │
│  │ review API  │  │ loopStep()    │  │ → AgentSession  │  │
│  └─────────────┘  └──────────────┘  │ → 写 STATE.md  │  │
│                                     └────────────────┘  │
│  唯一 DB 改动：cron_job.loop_config_path TEXT             │
├──────────────────────────────────────────────────────────┤
│  L4 Harness (packages/harness)                            │
│  AgentSession — Loop 的 building block：                  │
│  discovery prompt / generator prompt / evaluator prompt   │
│  每次调 prompt() 或 continue()，不感知 Loop 编排           │
├──────────────────────────────────────────────────────────┤
│  L3 Framework (packages/framework)                        │
│  createAgent(), plugin system, checkpointer, context mgr  │
├──────────────────────────────────────────────────────────┤
│  L2 Runtime + L1 Protocols (packages/core, message)       │
│  Message, ChatModel, Tool, run()                          │
└──────────────────────────────────────────────────────────┘
```

### 数据模型

```
┌─────────────────────────────────────────────────┐
│  文件系统                                        │
│                                                 │
│  .loop/                                         │
│  ├── config.yml        Loop 配置（model +       │
│  │                     每类 item 的 acceptance）│
│  ├── constraints.md    安全约束                  │
│  ├── skills/           SKILL.md 集合            │
│  │   ├── loop-triage/                          │
│  │   └── loop-verifier/                        │
│  └── STATE.md          运行时状态（item 表）     │
│                                                 │
│  ── STATE.md 是 item 状态的唯一源 ──            │
│  （例外：token 计数走原子计数器，不落此文件）    │
├─────────────────────────────────────────────────┤
│  数据库                                          │
│                                                 │
│  cron_job 表                                    │
│  └── loop_config_path TEXT  (新增，可为 null)   │
│                                                 │
│  Loop 不建新表；item 不进 DB。唯一破例是         │
│  per-loop token 计数（强一致，见 §7）。          │
└─────────────────────────────────────────────────┘
```

**`config.yml` 的 `acceptance` 字段（治点头回路的显式靶子）**：Goal 虽是临时态（翻译成配置后即丢弃），但「什么叫这条 item 修好了」这个**验收判据不能一起丢**——否则 evaluator 只有「scope 没越界 + 测试跑过」这类**过程合规**证据，对「生成 release notes」「给 issue 打标签」这类无测试可跑的非代码场景，evidence 字段填不出可执行证据，就退回「看着还行」的点头回路（PRD 边界情况「Evaluator 无法运行测试 → ESCALATE」正是这个洞的局部显形）。因此每类 item 在 `config.yml` 里带一个显式 `acceptance`（一句话的可观测判据，如「release notes 覆盖本周所有 merged PR 且无占位符」），evaluator 装配它作为对照靶子。这是把「显式停止条件」保留下来的**最小改动——加一个配置字段，不加实体**。

### 请求流

```
创建 Loop:
  POST /api/loops { intent: "..." }
    → intent-to-config 翻译器（LLM 调用）
    → scaffold .loop/ 目录（写 config.yml, constraints.md, skills/）
    → 创建 CronJob（loop_config_path = .loop/ 路径）
    → 返回 Loop 配置预览

Cron 触发:
  Bun.cron fires
    → CronScheduler handler
    → 读 cron_job.loop_config_path
    → loopStep(loopConfigPath)
      → 读 STATE.md + config.yml
      → discovery AgentSession.prompt("Run loop-triage...")
      → 写 STATE.md（parsed findings）
      → per finding: generator AgentSession → evaluator AgentSession
      → 更新 STATE.md（item step + result）
    → SSE push 进度到 Web

人审批:
  POST /api/loops/:id/review { itemId, verdict, feedback? }
    → loopStep(loopConfigPath, { action: { itemId, verdict, feedback } })
      → 读 STATE.md
      → loopReducer(state, action)
      → 写 STATE.md
      → 如果是 promote: 在目标 Loop 的 STATE.md 添加 item
```

## 7. 技术考量

### 架构影响

- CronJob 表新增一列（`loop_config_path TEXT`），向后兼容——已有 CronJob 不受影响
- Loop 不建新数据库表——避免了 migration 风险，文件系统即状态
- [已有 Issue 实体](../architecture/foundations/issue.md) 保持只读，不删除——避免破坏已有数据
- Generator/Evaluator 使用已有 [AgentSession](../architecture/harness/harness.md)，不需要新执行机制

### 与已有系统的依赖

| 依赖 | 用途 | 状态 |
|---|---|---|
| [AgentSession](../architecture/harness/harness.md) | discovery/generator/evaluator 的运行载体 | `current` ✓ 单实例可用；**并发池需新建** |
| [CronJob](../architecture/foundations/cron-job.md) | Loop 的调度触发 | `design`，需落地 |
| [progressive-skill plugin](../architecture/plugins/progressive-skill.md) | Loop skill 加载 | `current`，但 `.loop/skills/` **需加为第三个 root** |
| [fs-memory plugin](../architecture/plugins/fs-memory.md) | STATE.md 读写 | `current` ✓ 仅文件读写；**无锁，并发一致性另兜** |
| [checkpointer](../architecture/runtime/framework.md) | AgentSession 的状态持久 | `current` ✓ |
| [SSE 通道](../architecture/backend/conversation-projection.md) | Loop 运行实时推送 | `current` ✓ |

### 并发与一致性

PRD 把 STATE.md 定为 item 状态的唯一源，同时开了三条都会写它的入口——cron TICK、手动 `Run Now`、`POST /api/loops/:id/review`。三条路必须串行化，否则 STATE.md 被并发读改写会丢更新、预算 cap 被冲穿。关键澄清：**[CronJob 的单飞锁](../architecture/foundations/cron-job.md) 只在自然（cron）触发时拿锁**——手动触发和 review 直接调 `loopStep()`，根本不过 `CronScheduler.fire()`，碰不到那把 `inFlight` 锁。所以并发保护不能只靠它。

| 一致性问题 | 为什么 CronJob 单飞锁不够 | 本 PRD 的决策 |
|---|---|---|
| STATE.md 并发写（cron 跑时人点 Run Now / 提交 review） | 单飞锁只护 cron 一条路，手动/review 不经过它 | `loopStep()` 自持一把 **loop 粒度写锁**，三条入口共用；同一 Loop 同时只有一个 `loopStep()` 在改 STATE.md |
| 预算计数被冲穿 | 「读已用 token → 加本轮 → 比 cap」是非原子 read-modify-write，落文件必然竞态 | token 计数**不落 STATE.md**，走带锁/CAS 的 per-loop 计数器（DB 一行 upsert 或进程内带锁 accumulator） |
| STATE.md 损坏 / 格式演化 | —— | 版本号 + 向前兼容解析；parse 失败写 error event、跳过本轮、不崩溃 |

### 技术风险与缓解

| 风险 | 缓解 |
|---|---|
| STATE.md 并发写入冲突 | **loop 粒度写锁**串行化 cron/manual/review 三入口（不能只靠 CronJob 单飞锁，它只护 cron）+ API 幂等设计 |
| AgentSession 在 Loop 中大量并发创建导致资源耗尽 | `maxParallelFindings` 配置限制 + 进程级 AgentSession 池——**池当前不存在，须作为 P0 新建** |
| LLM 调用成本随 Loop 数量线性增长 | Budget guard per Loop + per-day cap（原子计数）+ 80% 告警 |
| Evaluator 和 Generator 同 model 导致虚高通过率 | 配置层强制不同 model，LoopRunner 启动时校验 |
| STATE.md 格式演化导致旧文件解析失败 | 版本号 + 向前兼容解析 + parse 失败时写 error event |
| 非代码 item 无可执行验收证据，evaluator 退回点头 | `config.yml` 每类 item 带显式 `acceptance` 判据，evaluator 装配为对照靶子（见 §6 数据模型） |

## 8. 实施计划

### Phase 1: MVP — 核心编排 + 单 Loop

- `loopReducer()` 纯函数 + 测试
- `loopStep()` 编排函数（discovery → generator → evaluator → human gate）
- `.loop/` 目录结构 + STATE.md 读写
- CronJob 加 `loop_config_path` 列 + handler 集成
- Loop CRUD API（创建/列表/详情/更新/删除/手动触发/review）
- Web：Loop 仪表盘 + 详情页（review queue + 运行历史）
- Web：自然语言创建对话框
- 预算保护 + denylist 强制执行

### Phase 2: 增强体验

- SSE 实时进度推送（Loop 运行时间线）
- Evaluator 通过 MCP 操作浏览器
- Post-run critique 展示和编辑
- 手动 item 添加 UI
- 多 Loop 仪表盘性能优化（分页、缓存）

### Phase 3: 高级能力

- Loop 之间 item 移动
- 已有 Issue 数据迁移工具
- Loop Ready Score 展示
- 多 Loop 协调与去重

## 9. 待决问题

- **已有 Issue 迁移策略**：Issue 数据如何收敛到 Loop？改 `issues` 表的 `source` 字段，还是在 Loop 的 STATE.md 重建？由后续 PRD 定义。
- **Loop 配置的版本控制**：`.loop/` 目录是否纳入 git？默认 `.gitignore` 排除 STATE.md（运行时状态），保留 config.yml + skills/（配置）？
- **多实例 Loop 运行**：如果同一个 Loop 被多个 backend 实例的 CronJob 触发（水平扩展场景），如何保证不重复执行？依赖 CronJob 的进程级 `Bun.cron` 做单飞，还是引入分布式锁？
- **Loop 模板的演进**：7 种内部模板是硬编码在代码里，还是作为数据文件加载？数据文件更方便增加新模板。

## 10. 附录

### 参考资料

- [Loop Engineering — Addy Osmani](https://addyosmani.com/blog/loop-engineering/)（2026-06，概念命名）
- [loop-engineering 参考仓库 — Cobus Greyling](https://github.com/cobusgreyling/loop-engineering)（patterns、skills、STATE.md 约定、安全模型）
- [Generator/Evaluator 分离 — Prithvi Rajasekaran, Anthropic](https://www.anthropic.com/engineering/generator-evaluator)（2026，为什么同 model 审查不靠谱）
- [Stripe Minions — Steve Kaliski, How I AI](https://www.howiai.tech/)（1,300 PR/周，确定性闸门与 LLM 步骤交错）
- [Loop Engineering IEEE 论文 — HuaShu](https://huasheng.ai/orange-books)（v260615，四层栈、五动作、四成本）

### 相关架构文档

- [CONTEXT.md](../../CONTEXT.md) § Loop、§ agentLoop、§ CronJob、§ Issue
- [Loop 领域实体](../architecture/foundations/loop.md)
- [LoopRunner 编排引擎](../architecture/backend/loop-runner.md)
- [Loop Pattern 内部模板](../architecture/foundations/loop-pattern.md)
- [Issue（将被 Loop 吸收）](../architecture/foundations/issue.md)
- [CronJob](../architecture/foundations/cron-job.md)
- [Orchestrator](../architecture/backend/orchestrator.md)
- [AgentSession](../architecture/harness/harness.md)
- [设计哲学](../architecture/design-philosophy.md)
