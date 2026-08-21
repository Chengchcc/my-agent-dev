---
id: foundations.loop-engineering
title: Loop Engineering
status: deprecated
owners: architecture
last_verified_against_code: 2026-07-28
summary: "agent 之上的第四层：不再一遍遍手写 prompt，而是设计出「替你 prompt agent 的 loop」。本页从第一性原理讲这层--内层 loop（一次 run）与外层 loop（跨轮工作）的区别、发现/交接/验证/持久化/调度五个动作、以及 maker-checker 为什么要拆成两条独立 Agent。本体不落数据库：配置在 .loop/ 文件、item 状态在 STATE.md、CronJob 只当调度者、loopStep() 无状态。Goal 是创建对话框里的过渡态，落地后消失，验收标准降为 config.yml 的 acceptance 字段。末尾「迁移说明」讲 MVP 如何把 Issue/Kanban 吸收成 Loop 的入口（入口统一、数据未统一）。"
depends_on:
  - foundations.loop
  - foundations.loop-pattern
  - backend.loop-runner
  - foundations.cron-job
  - agent.oma
  - design-philosophy
used_by:
  - flows.e2e-loop-verification
  - roadmap.future-work
---

# Loop Engineering
> ⚠ **tombstone（2026-08-21）**：本页描述的是 loop-engineering 第一性原理设计稿（内层/外层 loop、五动作、maker-checker 双 Agent 角色），其执行模型已被 [ADR 0025](../../adr/0025-loop-workflow-first-execution.md) 的 workflow-first 重写取代——Generator/Evaluator 分离角色已删除，状态落库（loop_item/loop_budget），不再有 STATE.md 唯一状态源。**新设计与代码一律以 [Loop](./loop.md)、[LoopRunner](../backend/loop-runner.md)、[Loop Pattern](./loop-pattern.md) 与 [ADR 0025](../../adr/0025-loop-workflow-first-execution.md) 为准**；本页仅保留历史设计推演，供理解「为什么当初这么想」。

Loop Engineering 是 agent 之上的第四层。前三层是 **Prompt（怎么说一句话）-> Context（怎么组织一次对话的上下文）-> Agent（怎么跑一次 run）**；这一层再往上退一步：**不再由人一遍遍给 agent 写 prompt，而是把「谁来提示 agent」这件事本身自动化掉**。一个 loop 从发现工作、交接上下文、验证产出、持久化状态、按时调度五个动作里自转，人只在明确的检查点介入。业界把这层的判断说得很直白--「你不该再手写 prompt 了，你该设计出替你 prompt agent 的 loop」[[Loop Engineering]](https://github.com/cobusgreyling/loop-engineering)。

## 内层 loop 与外层 loop

「loop」这个词在两个尺度上都成立，别混：

- **内层 loop = 一次 run**：模型「思考 -> 调工具 -> 读结果 -> 再思考」直到自认干完，由 agent 的运行循环驱动，用 `maxSteps` 兜底防单轮空转（框架层默认 32，Agent 覆盖为 50）。这是 [Agent 运行循环](../runtime/framework.md) 讲的层，也是 Claude Code agent-loop 描述的那一层。
- **外层 loop = 一件 item 跨多个 step**：本页讲的这层。它把一段段内层 run 用 item 的 step 状态机串起来——generator 修一次是**一次内层 loop**，evaluator 审一次又是**另一次内层 loop**，[loopStep()](../backend/loop-runner.md) 在它们之间按结果推进 item 的 step。

两层各有各的「停」：内层靠「模型自认干完 / 撞 `maxSteps`」，外层靠「evaluator 判定产出满足验收标准、且人拍板通过」。**关键区别**：内层 run 结束（哪怕 succeeded）只说明「这段循环跑完了」，不等于「这件 item 达标了」——后者由外层的 evaluator 对照验收标准判、再由人 review。这条区别贯穿全页，也是 evaluator「读裁决不读 run 终态」的根据（见 [Loop 验证端到端](../flows/e2e-loop-verification.md)）。

## 这层解决什么问题

一个能自己转起来的 loop，必须自己回答两个问题：

1. **靠什么驱动、又靠什么知道一件工作该停？**
2. **状态存在哪，才能让「等人几小时」不依赖进程一直活着？**

第一个问题的答案是**一个显式的验收标准 + 一个独立的验证者**。不是「一张票走到了最后一格」这种*隐式*的位置判断，而是「产出满足验收标准了没有」这种*可被验证*的谓词。这正是 maker-checker 里 checker 存在的全部意义——它就是来判断「到底达到没有」的。

第二个问题的答案是**把状态落到文件，让编排函数无状态**。human gate 可能等几小时，进程会重启、内存会丢；所以 item 状态必须在文件（STATE.md）里，每次触发独立调 [loopStep()](../backend/loop-runner.md) 读文件、跑一步、写回文件。

下面按「本体在哪、五个动作怎么落、验证怎么独立」三条把这层讲清楚。

## 本体在文件里，不在数据库

Loop **不新增数据库表**。这是整套设计最省的一刀：配置在 `.loop/` 目录的文件里，运行时 item 状态在 `STATE.md` 里，唯一的 DB 改动是 CronJob 表加一列 `loop_config_path TEXT`。详见 [Loop](./loop.md)。

```
.loop/
  config.yml       — generator/evaluator model + prompt + 每类 item 的 acceptance
  constraints.md   — denylist、budget cap、auto-merge 策略
  skills/          — discovery SKILL.md
  STATE.md         — 运行时 item 状态（首次运行时创建）
```

为什么是文件不是表？因为 Loop 的形状（几步、每步谁干、验收什么）是**配置**，不是需要 join/query 的关系数据；把它落成 `.loop/` 文件，既让用户可预览可手改，又让「Loop 没有自己的生命周期实体」这条不变量自然成立——Loop 只是「一组文件 + 一个 CronJob 指针」，不单独建表。这守住[设计哲学](../design-philosophy.md)「不要把实现机制上浮成业务本体」。

## 架构图

```mermaid
flowchart TB
  subgraph Trigger[触发层]
    CRON[CronJob\nloop_config_path]
    HUMAN[人 Run Now / review]
  end

  subgraph Step[执行入口：loopStep（无状态）]
    LS["loopStep({loopConfigPath, action?})\n读 STATE.md → 跑一步 → 写回"]
    RED["loopReducer(state, action)\n纯函数：item step 转移"]
    CRON -->|cron TICK| LS
    HUMAN -->|APPROVE/REJECT/PROMOTE| LS
    LS --> RED
  end

  subgraph Sessions[两条独立 Agent]
    GEN["Generator\nconfig.generator.model"]
    EVAL["Evaluator\nconfig.evaluator.model（≠ generator）\n怀疑姿态，动手验证"]
    LS -->|fixing item| GEN
    GEN -->|完成| EVAL
    EVAL -->|结构化 verdict| LS
  end

  subgraph State[状态与配置：.loop/ 文件]
    CFG[("config.yml\n+ constraints.md\n+ skills/")]
    ST[("STATE.md\nitem step 状态\n（唯一状态源）")]
    LS <--> ST
    LS --> CFG
  end

  subgraph View[投影层：只读]
    ST -.按 step 分组.-> KAN[/loops 看板]
    ST -.awaiting_review.-> RQ[review queue]
  end
```

一句话读图：**触发层**（cron 或人）调 [loopStep()](../backend/loop-runner.md) -> 它读 [STATE.md](./loop.md) 判当前该跑哪步 -> 起 **Generator/Evaluator 两条独立 Agent** 干活与验证 -> evaluator 的结构化 verdict 经 **loopReducer** 转移 item 的 step -> 写回 STATE.md -> **投影层**（看板 / review queue）只读 STATE.md，不参与控制。

## 五个动作怎么落

| Loop 动作 | 本体承载 | 状态 |
|---|---|---|
| **发现 Discovery** | `.loop/skills/` 里的 discovery SKILL.md，cron 触发时扫信号（挂测试 / TODO / 告警）→ 往 STATE.md 追加 `triaged` item | 🔴 新增 |
| **交接 Handoff** | 顺序 step 默认共享工作区；结构化交接走 config + STATE.md 的 result 字段；单 step 扇出才用 `git worktree` 隔离（bash + git，非新组件） | 🟡 顺序共享已有；扇出隔离按需补 |
| **验证 Verification** | `kind:"check"` 语义落成**独立 Evaluator Agent**（≠ generator model），对照 config.yml 的 `acceptance` 判定，产出结构化 verdict | 🔴 本设计核心 |
| **持久化 Persistence** | item 状态全在 STATE.md（跨进程重启不丢）；[fs-memory](../plugins/fs-memory.md) 提供文件读写但**无锁、单前缀**，并发一致性由 Loop 层自兜 | 🟡 STATE.md 是文件，并发写须加 loop 粒度锁（见下） |
| **调度 Scheduling** | [CronJob](./cron-job.md) 当调度者（`loop_config_path` 指向 `.loop/`），到点调 `loopStep()`；**两层预算**：内层 `maxSteps` 防单 run 空转、外层 budget cap 防 loop 空转 | 🟡 CronJob 已有，补 loop 触发与外层预算 |

## 验证：拆成两条独立 Agent 的 maker-checker

验证是五动作里最难的一个--生成者会夸自己的活。修法是**独立的怀疑者**：不同（通常更小）模型、默认「坏的直到证明能跑」、靠**动手**（跑测试、点按钮）而非读代码验证。这就是 maker-checker，在本设计里落成 **Generator 与 Evaluator 是两条独立的 Agent**：

```
generator run:  idempotency "loop:<loopId>:gen:<itemId>:<attempt>"   model = config.generator.model
evaluator run:  idempotency "loop:<loopId>:eval:<itemId>:<attempt>"  model = config.evaluator.model  ← 必须 ≠ generator
```

Evaluator 产出**结构化 verdict**（`PASS` / `REJECT: reasons...` + 证据）。[loopStep()](../backend/loop-runner.md) 解析它后喂给 `loopReducer`：`PASS` → item.step 进 `awaiting_review` 等人拍板；`REJECT` 且还有 attempt → 回 `fixing`（带拒绝理由）；attempt 耗尽 → `inbox`。

**关键接线**：loopStep 在 evaluator 跑完后**不看 run 是否成功**（run 成功只说明验证者跑完了），而读 **verdict 内容**转移 step。终态落在「产出是否满足 acceptance」这个业务谓词上，不靠旁路 run 状态硬猜——这是点头回路（Verifier Theater）的治本处。为什么不能把验证放进生成者的 Stop 钩子、也不用 subagent，见 [Loop 验证端到端](../flows/e2e-loop-verification.md)。

## Goal 是过渡态，验收标准落在 config

「什么叫成功」当然要显式——但它**不需要一个持久化的 Goal 实体**来承载。用户在创建对话框里说「让测试 X 通过 / 每天修简单的 CI 失败」，这句话是 **Goal，一个过渡态**：[意图→配置翻译器](./loop-pattern.md)把它翻译成 `.loop/config.yml`，**Loop 创建后 Goal 就消失**。它留下的沉淀，是 config.yml 里每类 item 的 **`acceptance` 字段**——evaluator 判定时对照的那把靶子。

这样处理有两个好处：一是**概念更少**（不为「要什么」单开一个跨生命周期实体，符合[设计哲学](../design-philosophy.md)「概念要少」）；二是**验收标准仍然显式**（它不是消失了，而是降维成 config 的一个字段，evaluator 每轮都读得到）。对非代码类工作（如 changelog、依赖升级），`acceptance` 就是那类 item 的显式完成定义，避免「没有靶子只能点头」。

## loopStep() 无状态 + loopReducer 纯函数

外层推进被拆成两块，都刻意做成**无副作用可复现**的形状：

- **[loopStep()](../backend/loop-runner.md)** 是无状态函数——每次 cron 触发或人 review 时调一次，读 STATE.md、跑一步、写回。它不保持内存状态，所以 human gate 等几小时、进程重启都不影响：`CronJob fires → loopStep() → 推到 awaiting_review → 返回`，几小时后 `人 approve → loopStep({action}) → 推到 resolved → 返回`。
- **`loopReducer(state, action)`** 是纯函数——给定当前 STATE 和一个 action（`TICK` 推进 triaged→fixing、`VERDICT` 按 evaluator 裁决转 awaiting_review/fixing/inbox、`APPROVE` / `REJECT_HUMAN` / `PROMOTE` 处理人 review），返回新 STATE，不碰 I/O。所有 item step 转移都收在这里，可单测、可重放。

item 的 step 状态机（定义在 [Loop](./loop.md)）：`triaged → fixing → verifying → awaiting_review → {resolved, inbox, promoted}`。

## 运营成熟度：报告 → 辅助 → 无人值守

一条 loop 立起来后，它的**自主度**应当分级放权，而不是一上来就无人值守。参考实践把这条阶梯定为 L1 报告 → L2 辅助修 → L3 无人值守，铁律是「每加一档自主度，都要等上一档证明了价值和它的失败模式」[[Loop Engineering]](https://github.com/cobusgreyling/loop-engineering)。创建时**默认 L1**（report-only，不启动 generator）；用户积累足够信任（evaluator 稳定拒绝错误产出）才升 L2（有人审批落地）、L3（严格约束下自动 resolve）。这套信任层级由 [Loop Pattern](./loop-pattern.md) 承载。

> **两条 L 轴别混**：这里的 L1/L2/L3 是「一条已建好的 loop 怎么一档档放开手」的**自主度**；[未来工作](../roadmap/future-work.md) 里的 Phase 1/2/3 是「按什么顺序把这套本体建出来」的**实现顺序**。是两条正交的轴。

## 并发与一致性（一等约束）

STATE.md 是 item 状态的**唯一源**，但同时有三条都会写它的入口：cron `TICK`、手动 `Run Now`、`POST /api/loops/:id/review`。三条必须串行化，否则并发读改写会丢更新、预算 cap 被冲穿。关键澄清：**[CronJob 的单飞锁只在自然（cron）触发时拿锁**——手动触发和 review 直接调 `loopStep()`，根本不过 `CronScheduler.fire()`，碰不到那把 `inFlight` 锁。所以并发保护不能只靠它：`loopStep()` 须自持一把 **loop 粒度写锁**，三条入口共用；预算计数**不落 STATE.md**，走带锁/CAS 的 per-loop 计数器。完整决策见 PRD 的「并发与一致性」一节。

## 不变量（设计契约）

1. **Loop 不新增数据库表**：配置在 `.loop/` 文件，item 状态在 STATE.md，唯一 DB 改动是 `cron_job.loop_config_path`。
2. **CronJob 是调度者，Loop 是被调度者**：Loop 不持有 schedule 字段。
3. **Generator 与 Evaluator 是两条独立 Agent，不同 model**：验证换一条独立线，不让写代码的人自己判自己的活。
4. **evaluator 读 verdict 内容转移 step，不看 run 终态**：终态落在「是否满足 acceptance」这个业务谓词上。
5. **item 状态在 STATE.md，跨进程重启不丢**：human gate 不依赖进程存活。
6. **loopStep() 无状态、loopReducer 纯函数**：状态全在文件，转移可单测可重放。
7. **Goal 是过渡态，不持久化**：创建对话框输入 → 翻译成 config → 消失；验收标准沉淀为 config.yml 的 `acceptance` 字段。
8. **STATE.md 并发写走 loop 粒度锁，预算计数走原子 CAS**：不能只靠 CronJob 单飞锁（它只护 cron 一条路）。
9. **预算是硬上限，分两层**：内层 `maxSteps` 防单 run 空转；外层 budget cap 防 loop 空转，超限触发熔断（暂停调度、追加 run-log、留一扇门给人）。
10. **隔离只由单 step 扇出触发**：顺序 step 默认共享工作区；只有同一 step 并行起多 agent 时才用 `git worktree`（bash + git，非新组件），用完即弃。
11. **检查先于并行**：并行 loop 排在验证被证明可靠之后，不在本设计范围。
12. **自主度分级放权**：loop 上线走 L1 报告 → L2 辅助 → L3 无人值守，每档等上一档证明价值后再放开。

## 迁移说明：MVP 只统一入口，不统一数据

> 以下面向**了解现状代码**的读者。只想理解 Loop Engineering 本身，读到上一节即可停。

历史上有两个独立实体：Issue（已删除）管手动工作流、[CronJob](./cron-job.md) 管定时触发一次 run。两者都不表达「按调度自动发现工作 + 多步流水线推进 + 跨轮状态持久」。Loop 把这两个概念统一：CronJob 退成调度者、Issue 的工作流被 Loop 的 step 状态机吸收、手动工作 = `trigger=manual` 的 Loop。

**但 MVP 是入口统一、数据未统一，这是已知代价**：本设计只把 `/issues` 从导航移除、Issue 表保持**只读且不迁移**（迁移工具列入未来 P2）。所以底层仍有 Issue 表与 Loop 的 STATE.md 两处状态并存；`/loops` 成为和 `/conversations` 并列的用户可见工作入口，但这不代表底层数据已收敛。真正的单一数据源要等 Issue 迁移工具落地。

为什么这样切？因为一次性做「Issue→STATE.md 数据迁移 + 入口统一」风险太大；先用最小 DB 改动（加一列 `loop_config_path`）把 Loop 立起来、把入口收敛，验证这套文件态模型跑得通，再谈数据迁移。这是 grilling 后确认的 MVP 取舍。

完整迁移设计与落地顺序见 [未来工作](../roadmap/future-work.md) 的 Loop Engineering 条目。

## 关联页面

- [Loop](./loop.md) — 本体：`.loop/` 布局、STATE.md、item step 状态机、不变量
- [LoopRunner](../backend/loop-runner.md) — `loopStep()` 无状态编排函数 + loopReducer
- [Loop Pattern](./loop-pattern.md) — 7 种内部模板、意图→配置翻译、L1/L2/L3 信任层级
- [Loop 验证端到端](../flows/e2e-loop-verification.md) — 一次触发里 generator/evaluator 怎么串起来
- [定时任务](./cron-job.md) — Loop 的调度者
- [Agent](../harness/harness.md) - generator/evaluator 的运行时
- [架构设计哲学](../design-philosophy.md)
- [未来工作](../roadmap/future-work.md)
- [文件型记忆插件](../plugins/fs-memory.md)
- [Agent 运行循环](../runtime/framework.md)
- 外部参考：[Loop Engineering 参考库（cobusgreyling）](https://github.com/cobusgreyling/loop-engineering)、[Claude Code agent-loop](https://code.claude.com/docs/en/agent-sdk/agent-loop.md)
