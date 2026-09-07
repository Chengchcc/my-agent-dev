---
id: roadmap.future-work
title: 未来工作
status: future
owners: architecture
last_verified_against_code: 2026-08-05
summary: "这一页是唯一谈「还没做 / 想做」的地方——刻意和描述当前状态的所有页面隔离开，避免把「现状」和「设想」混在一起误导读者。其余每一页都只讲代码现在确实是怎样的；任何前瞻性的方向都收拢到这里，并标注它依赖哪些现有抽象。"
depends_on:
  - runs.output-and-live-updates
  - surfaces.lark
  - runtime.oma
  - foundations.loop
  - backend.loop-runner
used_by:
---

# 未来工作
> ⚠ **需复核(2026-08-13)**：本页部分条目已落地或已废弃（如 relationships 已删、记忆已吸收进工作区文件、多后端已实现）——每条以最新 ADR 索引为准。

这一页是唯一谈「还没做 / 想做」的地方——刻意和描述当前状态的所有页面隔离开，避免把「现状」和「设想」混在一起误导读者。其余每一页都只讲代码现在确实是怎样的；任何前瞻性的方向都收拢到这里，并标注它依赖哪些现有抽象。

## 为什么单独成页

整套文档遵循「现状优先」：每一页描述的都是代码此刻真实的样子，可被 `last_verified_against_code` 核对。如果在正文里夹杂「将来会改成 X」，读者很难分清哪句是现在、哪句是设想。所以所有前瞻内容统一放这里，正文保持纯粹。

## 方向（与现有抽象的关系）

> 以下为方向性条目，不代表已实现；落地前请以对应当前状态页为准。

- **更细的投影可见性策略**　当前 assistant 消息经 `onRunMessage` 直写账本，projection bridge 只做 best-effort fan-out。未来可引入更细的可见性规则（按成员、按事件子类型），但任何扩展都应保持「assistant 消息与人类消息同一入口直写账本」「账本为唯一对话事实」这两条不变式。依赖：[会话投影](../runs/output-and-live-updates.md)、[事实与投影](../foundations/facts-and-projections.md)。
- **端去重的统一化**　**已解决。** 飞书侧的 `canSkipFinalLedgerText` 及相关 dedup 逻辑已随 Lark 重构移除，SSE 事件直接渲染。当前仅 Web + Lark 两端，各自无去重负担。若未来接入更多端再考虑共享去重层。
- **恢复语义的强化**　**历史方案，已随 Phase 5/6 删除。** checkpointer 的 saveInterrupt / consumeInterrupt 与整个 session 持久化体系已不存在。当前语义：中断/崩溃 = 当前 Agent Run failed；下一个输入 = 新 Run = 从 Agent Context full projection 重建，无恢复路径。
- **Issue 协作工作流演进**　**已被 Loop 取代。** Issue 本体与 Orchestrator 模块已删除（无 `features/orchestrator/`、无 Issue CRUD），工作流编排能力由 Loop 系统承接（workflow-first：fix/verify 子 agent + human gate，见 [ADR 0025](../../adr/0025-loop-workflow-first-execution.md)）。M18.3-M18.7 里程碑失效，Project 实体化已独立落地（`features/project/` CRUD 已完成）。旧 `span_origin` 表（含 issueId 列）已随 Phase 6 迁移 0020 删除。
- **@提及收编进编排**　**已解决。** Orchestrator 已删除，@提及自动触发（`conversation/service.ts` 的 `#forkAgentRuns`）是唯一驱动来源。两套驱动的问题不存在了。
- **产品力审查发现（2026-07-13）**　从业务故事线（在场协作 / 离场托付 / 系统管理）出发的全面审查，识别出以下产品缺口。**大部分已于 2026-07-14 修复**，标注 ✅ 已完成 / ⏳ 待办。

  | 优先级 | 缺口 | 故事线 | 状态 | 修复内容 |
  |---|---|---|---|---|
  | **P0** | Goal state 持久化 | 离场托付 | ✅ 已完成 | `goal-state.ts` 改为 `createGoalStateStore(settingsSvc)`，condition+paused 持久化到 settings KV 表 |
  | **P0** | Cron Job 管理页缺失 | 系统管理 | ✅ 已完成 | System 页加 Cron Jobs tab，复用已有 CronJobForm + hooks |
  | **P1** | Session 浏览器 | 系统管理 | ✅ 已完成 | System 页加 Sessions tab，复用 `useOpsSessions` |
  | **P1** | Run detail 从 System 可达 | 系统管理 | ✅ 已完成 | RunOpsTable 行可点击 -> `/system/runs/[runId]` 独立详情页 |
  | **P1** | Lark 绑定流程断裂 | 双端同步 | ✅ 已完成 | AgentForm 创建模式显示提示，保存后跳转编辑页做 setup |
  | **P1** | MCP 连接状态不回填 | 系统管理 | ✅ 审计误报 | service.ts 已填充 status/toolsCount，McpServerPanel 已显示 |
  | **P2** | Loop 不可暂停 | 离场托付 | ✅ 已完成 | `POST /api/loops/:id/deactivate` + `useDeactivateLoop` hook + UI toggle |
  | **P2** | Loop 预算历史无 API | 离场托付 | ✅ 审计误报 | 已通过 `GET /api/loops/:id` 返回，detail 页已渲染 |
  | **P2** | Stop 按钮不直观 | 在场协作 | ✅ 已完成 | ConversationCanvas busy 状态显示 Stop 按钮 |
  | **P2** | Goal 不可视化 | 在场协作 | ✅ 已完成 | ConversationCanvas 加 GoalStatusBar，显示条件/轮次/暂停/恢复/清除 |
  | **P2** | System 页 Traces tab 误导 | 系统管理 | ✅ 已完成 | tab 改名为 "Runs"（诚实命名），行可点击进入 `/system/runs/[runId]` |
- **Solo 项目借鉴（2026-07-14）**　分析了 [solo-agent/solo](https://github.com/solo-agent/solo) 的关键子系统，以下 4 项设计值得借鉴，按实现难度排序：

  | 优先级 | 功能 | Solo 设计 | 我们现状 | 成本 |
  |---|---|---|---|---|
  | **P0** | 连接状态指示器 | `network-status.tsx` 65 行：`navigator.onLine` + online/offline 事件 + 顶部 banner（offline 红色 / 恢复绿色 3s 后隐藏） | `streamConn` 状态已有但零 UI 反馈，SSE 断了用户看到冻结画面无感知 | 1 小时 |
  | **P1** | Agent 关系图 + Wake Routing | 两种关系 `assigns_to`/`collaborates_with`（带 weight + instruction）；关系变更自动生成 `RELATIONSHIPS.md` 写入 agent workspace；coordinator 选择 ~20 行算法（遍历关系图找无 parent 的根节点）；wake routing ~55 行（有 @mention 只唤醒被提及的；无 @mention 自动选 coordinator） | agent 之间扁平，靠用户手动 @mention 路由，无 coordinator 概念 | 3 天 |
  | **P1** | Task 看板 + Claim Window | 5 状态 `todo→in_progress→in_review→done/closed`，严格转换矩阵；claim 窗口 ~155 行纯内存（@mention 的 agent 有 30s 独占认领权，超时放给其他 agent）；actor 权限（agent 不能 close/reopen，只有 creator 能 accept）；agent 旁路 `CompleteTaskForAgent` 跳过 guard 自动提交 review | Loop `ItemState` 已有 priority/step/awaiting_review，数据模型在但缺 UI 看板层 | 3-5 天 |
  | **P2** | CMD+K 全局搜索 | ✅ 已完成 | 全屏 overlay + 300ms 防抖 + ↑↓Enter Esc 导航 + 点击跳对话 + 右下角 ⌘K 提示按钮。后端 `searchLedger` JOIN member/conversation 返回 sender/title | 2026-07-22 |

  Solo 的设计亮点模式（实现时参考）：
  - **URL as state**：面板/视图/task/thread 状态编码到 URL searchParams，可分享、可前进后退
  - **双 hook 模式**：`useInbox`（分页列表）+ `useInboxUnread`（轻量计数）分开，badge 频繁轮询不拉全量数据
  - **乐观更新+回退**：markRead 先本地标记，API 失败 refetch 回退，比 mutation onSuccess 更快
  - **Flash highlight**：选中 agent 后 1.5s 高亮消失，平滑引导注意力

  不值得借鉴的：daemon/computer 管理（架构不兼容）、WebSocket hub（SSE 够用）、artifact HTML 生成（过重）、channel team graph ReactFlow（130KB 依赖，文本 RELATIONSHIPS.md 足够）、thread panel（940 行，扁平对话够用）。
- **Pi 架构借鉴（2026-07-17）**　分析了 [earendil-works/pi](https://github.com/earendil-works/pi) 的核心架构设计，以下按优先级记录值得借鉴的技术架构点：

  | 优先级 | 设计 | Pi 做法 | 我们现状 | 成本 |
  |---|---|---|---|---|
  | **P0** | Provider 注册制 | ✅ 已完成 | `@chengchenccc/ai` 包，Provider/ModelRegistry/anthropicProvider，启动时注册全局复用 | 2026-07-17 |
  | **P0** | Model 对象替代裸字符串 | ✅ 已完成 | Model 带 cost/contextWindow/maxTokens/reasoning/input，agent 配置存 provider/id | 2026-07-17 |
  | **P1** | Hook 事件返回类型 | `AgentHarnessEventResultMap` 每个 hook 有明确返回类型，`beforeProviderRequest` 可 per-call 改 headers/timeout/retries | `PluginHooks` 返回值简单，无 `beforeProviderRequest` hook，无法 per-call 注入 headers | 2 天 |
  | **P1** | AgentMessage declaration merging | ⏳ 待办 | Message 是固定 union | 半天 |
  | **P2** | ExecutionEnv 抽象 | ⏳ 待办 | 工具直接用 node:fs 和 Bun.spawn | 3-5 天 |

  | **P0** | Session Tree + Checkpointer 拆分 | ⏳ 已删除 | 见下方专节（历史方案，Phase 5/6 删除，被 per-Run in-memory SessionStore 取代） | 2026-08-05 |
  | **P3** | Result<T,E> 错误类型 | `Result<TValue, TError>` 显式 `{ok, value} \| {ok: false, error}`，不依赖 throw | 全用 throw + try/catch + DomainError 层级 | 低（风格偏好，不值得迁移） |
  | **P3** | Tool terminate 标记 | `AgentToolResult.terminate: boolean`，工具可标记"执行后终止 agent loop" | 无，工具不能主动终止 loop（InterruptSignal 已覆盖类似场景） | 低 |

  Pi 的 Provider 设计已落地：`@chengchenccc/ai` 包，`anthropicProvider` + `openAICompletionsApi` + `createOpenAICompatProvider`，删掉 `@anthropic-ai/sdk` 依赖，直接 fetch + SSE 解析。加新 provider（DeepSeek/Groq/custom）只需 5 行配置。

  不值得借鉴的：OAuth（桌面端场景）、动态 model 列表拉取（可后加）、TypeBox 类型（我们用 zod 已够用）。
- **Session Tree + Checkpointer 拆分（2026-07-17）**　**历史方案，已随 Phase 5/6 删除。** Checkpointer / MessageStore / EventLog / InterruptStore 拆分、Session Tree（SQLite session 文件、SessionRepo、SessionManager）均已不存在。当前 Runtime 状态是 per-Run、in-memory 的 SessionStore（`packages/agent`），Run 结束即销毁；产品恢复只依赖 Conversation History 与 Agent Context。

  Conversation fork/undo/replay 仍落地（migration 0011，ledger 软删除 + fork 来源追踪）。

  不做：Pi 的 `CustomAgentMessages` declaration merging（Message 类型已稳定）、`Result<T,E>` 错误类型（风格偏好）。
- **oh-my-pi 架构借鉴（2026-07-21）**　分析了 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) 的增强架构，以下值得借鉴：

  | 优先级 | 设计 | OMP 做法 | 我们现状 | 成本 |
  |---|---|---|---|---|
  | **P1** | Append-Only Context（Prompt Cache 优化） | ✅ 已完成 | identityPlugin mtime 指纹缓存 system prompt | 2026-07-21 |
  | **P2** | Compaction "Shake"（机械缩减） | ✅ 已完成 | shakeMessages 在 autoSummarize Step 1 机械替换大 tool_result | 2026-07-21 |
  | **P2** | Tool Protection（工具结果保护） | ✅ 已完成 | shakeMessages protectedTools 配置，默认保护 skill | 2026-07-21 |
  | **P2** | Pause Gate（进程级暂停） | ❌ 不做 | 服务端运行时不需要，/stop 够用 | - |
  | **P3** | Telemetry（OTel GenAI 语义约定） | ⏳ 待办 | 无当前 implementation；旧 runtime-observability 已删除。未来如做，按 child-process 链路（每次 Run 的 adapter 侧）重做，不引入常驻进程观测 | 1 周 |
  | **P3** | Tokenizer（精确 token 计数） | ✅ 已完成 | countTokens/countMessageTokens 工具函数 | 2026-07-21 |

  OMP 的 dialect 系统（anthropic/deepseek/gemini/glm/kimi/qwen3 等 15+ 个 dialect 的 prompt 格式适配）不值得抄——我们的 API 层已有消息转换，且不需要 thinking 格式适配（不同模型的 reasoning 格式差异由 API 层处理）。
- **Autonomous Memory（自主记忆）（2026-07-22）**　**历史方案，已随 Phase 6 删除。** `plugin-fs-memory` / `plugin-memory` 包不存在；memory.autoExtract 等 settings 已从 UI 移除。当前没有 autonomous memory pipeline producer。Agent 详情页 Memory tab 仍存在，但只读取 workspace 中已有的文件（如 memory/facts、memory_summary.md），不做自动提取/合并。若恢复，必须作为 Oma 或 Product 侧的真实能力重做。


- **Pet（陪伴审查 agent）（2026-07-21）**　**历史方案，已随 Phase 6 删除。** `packages/plugin-pet`、PetStatusBar、Pet tab、`pet.*` settings、`pet_bark` LedgerKind/SSE 事件均不存在（源码 clean search 为零）。若未来恢复，Pet 必须作为 Product-side post-run feature 重新设计（不恢复 runtime plugin）。

- **Provider 配置化（models.yml + 环境变量自动检测）（2026-07-22）**　✅ **已完成**。在 Pi Provider 注册制基础上，将 Provider 从代码注册升级为声明式配置：

  | 组件 | 内容 |
  |---|---|
  | **models.yml** | 可选 YAML 配置文件，声明 provider（api/baseUrl/apiKey env var/models） |
  | **自动检测** | 无 yml 时根据 `ANTHROPIC_API_KEY`/`DEEPSEEK_API_KEY`/`OPENAI_API_KEY` 自动注册内置 provider |
  | **resolveModel** | 统一模型解析入口，支持 `"provider/id"` 和 bare id 两种格式 |
  | **前端下拉** | AgentForm provider+model 级联 Select，`/api/models` 动态加载 |
  | **Runtime 替换** | 12 处 `getModel("anthropic", ...)` 全部替换为 `resolveModel(name, registry)` |
  | **LedgerKind** | 加 `pet_bark` 枚举值，pet bark 事件通过 conversation SSE 转发到前端（该枚举已随 Phase 6 Pet 删除） |

- **Recap Panel（每轮对话实时摘要）（2026-07-22）**　**历史方案，已随 Phase 6 删除。** `plugin-recap`、`recap_update` 事件、RecapPanel、`recap.*` settings 与 `recap` LedgerKind/SSE 事件均不存在。若未来恢复，Recap 必须作为 terminal Message 之后的 Product-derived summary 重新设计。
- **Compaction 质量提升（2026-07-22）**　✅ **已完成**。三个改进全部落地 + 架构文档（`docs/architecture/runtime/compaction.md`）：

  | 改进 | 来源 | 实现 |
  |---|---|---|
  | **结构化摘要 prompt** | OMP `compaction-summary.md` | 替换 5 段中文为 8 段英文 markdown（`compaction/prompts.ts`） |
  | **迭代更新 prompt** | OMP `compaction-update-summary.md` | `updateSummarize` + `previousSummary` 选项 |
  | **智能切点** | Pi `findCutPoint` | 从尾部反向累 token，只停在 user/assistant 边界，双向 fallback |
  | **废弃别名** | — | 删除 `summarizingContextManager`，完成重构 |

- **删除 transport / heartbeat 残骸**　**已解决。** `attempt` 表的 `pid` / `heartbeat_at` 列已删除（migration 0009），reaper 心跳分支已移除。Phase 6 进一步删除了整个 span/attempt/control_plane_event/span_origin 审计体系（迁移 0020）；Ops 面以 Agent Run 为中心（`/api/agent-runs`），无 session/span 概念。
- **Harness 运行时加固（M22）**　**历史方案，已随 Phase 5/6 删除。** harness/framework 包与进程内运行循环已不存在；其产物（steering/follow-up、工具并行、压缩管线）以 Oma Runtime 形式保留在 `packages/agent`（per-Run、子进程内），相关当前页面见 [Oma](../runtime/oma.md)。

## Loop 剩余功能（2026-08-20 记录，先测试后补）

Loop 已闭环：发现（auto-triage）/ 创建（四要素+workflow 模板）/ 运行（workflow 一等 fix/verify）/ 评估（verifyCommands 强制验收）/ 恢复（超时取消 + Doctor 巡检）/ 管理（taskClass/defer）。设计见 ADR 0025。以下为**未实现/待验证**项，先做真实运行验证，再按需推进：

| 优先级 | 项 | 说明 |
|---|---|---|
| P0 | **真实运行验证** | 用真实模型在真实 repo 跑完整 loop，暴露实际短板（fix 质量 / verify 命令真实性 / triage 发现质量） |
| P1 | **loop 级监控** | 产出数、验收通过率、烂尾率聚合视图（telemetry 是 run 级，loop 级无统计） |
| P1 | **inbox 自动清理** | stale/dead item 自动归档或过期（doctor 已把 stale 转 inbox，仍缺自动收尾） |
| P2 | **webhook 触发** | 外部 CI/issue 推送信号到 `POST /triage`（已预留落点，需 secret） |
| P2 | **verify 双模型** | fix 用贵模型、verify 用便宜模型（`agent()` per-agent model 扩展） |
| P2 | **配置演进** | LOOP.md 在线编辑 / refine 真正按新意图重新生成（接 loop-config-generator AI） |
| P2 | **cron next-run 展示** | UI 显示下次触发时间（Bun.cron 不暴露，需自算） |


## 处理原则

这个项目对技术债的态度是**及时彻底修复，没有任何项目内容不可改动**。因此这一页不是「攒着不还的债务清单」，而是「明确标注、择机推进、改动时一并到位」的方向记录。任何一项推进时，都应连带更新它所依赖页面的当前状态描述，使文档持续与代码对齐。

## 关联页面

- [架构 Wiki 首页](../README.md)
- [事实与投影](../foundations/facts-and-projections.md)
