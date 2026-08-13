# ADR 0021: Conversation 是 Coding Agent Session 的产品态投影,一个 Conversation 一个 Agent

## 状态

Accepted(2026-08-13)

## 上下文

早期设计里 conversation 是一个多成员空间:member 表形成 roster(agent/human 混合),支持多 agent 并存、@mention 定向触发、wake routing 选协调者、agent 间 relationship 图。

近期收编暴露了这套机制的成本与方向性错误:

- **relationships 已删除**(2026-08-13):多 agent 协作图无真实使用者;wake routing 退化为无图 fallback。
- **@mention / 多成员定向**:只服务"一个 conversation 里多个 agent 抢话",从未被真正需要;无 UI 入口,loop/lark/web 实际都是单成员用法。
- **方向问题**:按 ADR 0019(双轨真理),CLI session 是运行态真理(runtime truth,由 coding agent 原生维护),context tree/ledger 是产品态真理(product truth)。conversation 就是 coding agent 的 session 在 backend 上的**产品态投影**——它是产物,不是容器。一个 session 属于一个 agent,它的投影天然是一条 agent 线;把多个 agent 的投影塞进同一个 conversation,是让多个运行态真理共用一个产品态投影,没有任何共享语义。

**投影的边界(本节是约束,不是比喻)**:投影只约束**形状**,不构成**来源**。conversation 与 session 是两条独立持久化线,互不可重建,也互不等价:

- conversation 有 session 没有的东西:undo/fork 历史、pin/retain、steer 排队轮次、human 消息;
- session 有 conversation 没有的东西:CLI 原生工具全流量、compaction、retry(ADR 0020 决策 7 明确丢弃);
- 产品只存 `cliSessionRef` 不透明引用,不解析 session 文件;session 删除后 conversation 仍在。

因此**禁止任何"从 session 推导/重建 conversation"的实现**(如"删 ledger 从 session 回放")——那会丢掉 undo/pin/human 消息。投影 = 形状对齐,不是数据同源。

## 决策

1. **一个 conversation = 一个 agent 的产品态投影**。conversation 内 kind=agent 的 member 恰一个;human 消息作为 conversation 的外部事件进入(不建 human member——web/lark 的发送者身份由 surface 层解决,ledger 的 sender 模型随迁移简化,见后果)。
2. **conversation 跨多个 session,投影的单元是 agent 的上下文线**:session 是线上的段,切 kind(ADR 0019 决策 2)在**同一个 conversation** 里 fork 新 branch 标记断点——与 ADR 0020 的"切 kind = 新 session"一致,conversation 不因 session 切换而重建。
3. **多 agent 协作 = 多 session、多投影、同一事情**:当一件事情需要多个 agent 时,每个 agent 有自己的 session 和自己的 conversation 投影,多个 conversation 共同引用同一"事情"实体。agent 之间不共享 session、不共享 conversation、不共享 context tree(与 ADR 0019/0020 隔离语义一致)。
4. **"事情"挂载点方向**:conversation 加可选 `thingRef`,方向选 **work**(现有 work/loop surface 已是多 agent 汇聚的自然宿主),不新造实体。work 级聚合视图是后续设计,本 ADR 只定挂载点。
5. **显式接受单 agent 期**:多成员机制删除后、"事情"聚合落地前,产品是纯单 agent 的。这是显式决策,不是简化副作用——多 agent 能力是"事情"实体的 mandate,不免费。

## 后果

- **Schema/迁移**:member 表收编(单 agent member 约束);conversation 表加可选 `thingRef`(work 挂载,字段落地随 work 聚合设计)。
- **Service 简化**:resolveTriggerTargets、mention cascade、addressed_to 随单 member 模型退化或删除;wake routing 保持无图 fallback(已实现)。
- **Web**:chat 页去掉 roster 多成员 UI;一个 conversation 一个 agent 的展示;RelationshipPanel 已随 relationships 删除。
- **后续设计**:"事情"聚合(work 级多 conversation 视图、thingRef 语义)另开 ADR。
- **迁移策略**:本 ADR 定模型;表结构与 UI 迁移按"先决后迁"在后续变更中落地,每步可回滚。
