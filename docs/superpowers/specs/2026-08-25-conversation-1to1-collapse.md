# Conversation 1:1 塌缩 — LedgerEntry 退出 wire、member 让位于 conversation.agentId

> **Status:** Spec → Ready for implementation.
> **Baseline commit:** `6a141f6a` (2026-08-25).
> **关联:** `docs/superpowers/specs/2026-06-16-m17.1-message-model-boundary-refactor.md`（本 spec 是其未竟的下半场） · `docs/architecture/e2e-contract-rules.md` · `packages/conversation/src` · `packages/api-contract/src/sse.ts` · `apps/backend/src/features/conversation/service.ts` · `apps/backend/src/bootstrap/features.ts` · `apps/web/src/lib/conversation-reducer.ts` · `apps/lark-bot/src/ingest.ts`。

## 1. 背景与动机

产品已经事实上收敛为 1:1：web 建会话恒为 1 agent + 1 human（`apps/web/src/components/NavRail.tsx` quick-create、`useStartChat`），loop/cron 会话各挂 1 个 owner agent。但 domain 层仍完整保留群聊时代的参与抽象（member 表、mention 路由、member notices）和 event-sourcing 信封（LedgerEntry 作为 SSE 公共载荷）。

M17.1 已判定"Surface 不直接理解 ledger / EventLog / checkpoint row"，并下压了 MessageRevision 本体；但 entry 外壳仍裸漏在 SSE 上，web/lark 每个消费者都在做 `JSON.parse + parseMessageRevision` 的双重税。本 spec 完成这最后一半，并顺路拆掉 member 间接层。

**这不是兼容性改造，是边界纠偏。** 群聊时代的多成员机制不作为兼容目标保留。

## 2. 当前代码事实（基于 `6a141f6a` 核验）

### 2.1 产品形态

1. web 会话创建恒为 1 agent + 1 human：`NavRail.tsx:91-101` `members: [{memberId: agentId, kind:"agent", agentId...}, {memberId: humanId, kind:"human"}]` —— **memberId 与 agentId 同值**。
2. loop 会话：`loop-service.ts:279` `memberId:"owner", agentId:"default"`；cron：`memberId: OWNER_MEMBER_ID`（常量）+ 真实 agentId —— 合成 memberId 不承载 agentId 之外的信息。
3. HTTP 建会话 schema 只接受 `t.Optional(t.Literal("mention"))`（`conversation/http.ts:66`）；`triggerMode:"all"` 的 wake routing 分支（`service.ts:393`）对新建会话不可达。
4. `LedgerKind "todo"` 全仓零写入者（web todo 已改走 Run SSE transient，`conversation-reducer.test.ts:120-123` 注释确认）。

### 2.2 memberId 是空转的间接层

5. 每个收到 agentMemberId 的服务第一件事就是 join 回 agentId：`bootstrap/features.ts` 的 `resolveRunConfig`(:271)、`resolveAgentEnabled`(:296)、`resolveWorkspace`(:442) 全部 `members.find(m => m.memberId === agentMemberId) → member.agentId`。
6. busyGuard 用子查询做同一件事：`features.ts:251` `agent_member_id IN (SELECT member_id FROM member WHERE agent_id = ?)`。
7. `agent_context_tree` 双键 `(conversationId, agentMemberId)`（`agent-context/adapter-sqlite.ts:80-140`）；1:1 下 conversation→agent 是函数，第二键冗余。
8. run 幂等键 `${conversationId}:${seq}:${agentMemberId}`、`agent_run.agent_member_id` 列、run commit 写 ledger 用 `senderMemberId: run.agentMemberId`（`agent-run/adapter-sqlite.ts:853`）。
9. member.displayName 只是抄送 agents 表的 name（`NavRail.tsx:98` `displayName: agent?.name`）。

### 2.3 LedgerEntry 是机制不是本体

10. web 消费 entry 实际只用：`seq`（游标/undo/fork 定位）、`senderMemberId`（roster 归属）、`kind`（分发）、`content`（parse 后用）。`conversationId` 冗余（已订阅）、`ts` 不进 UiItem、`addressedTo` 仅原样存着回传 replay（`Timeline.tsx:404`）。
11. 三个消费者（web reducer、lark `sse-watcher.ts`、web `EvidenceChainPanel.tsx`）各自做一遍 content 反序列化。
12. `POST /messages` 的 `senderMemberId` 是客户端自报，无 auth 绑定 —— 冒充向量。
13. `MessageRole = "system" | "user" | "assistant" | "tool"`（`packages/message/src/message.ts:3`），包内注释已明确 authorship（role）与 participation（Member.kind）是两层。1:1 下 role 与成员双射：user↔人类、assistant/tool↔agent、system↔`__system__`。
14. 包内死导出：`assertMember`/`assertAgentMember`/`MemberNotFoundError`/`NotAgentMemberError`/`serializeLedgerEntry` 全仓零外部调用者。

### 2.4 群聊残留

15. `addressedTo` 的活语义只剩两处：触发路由（`resolveTriggerTargets`，`service.ts:390`；lark 群聊 @mention fail-closed `ingest.ts:148-157`）与 agent 上下文可见性过滤（`agent-run/adapter-sqlite.ts:310-314`、product-tools `service.ts:119-123`：`broadcast || addressedTo 含我 || 我发的`）。
16. web 1:1 下 `resolveAddressedTo()` 恒等于 `[唯一agent]`（`useConversation.ts:65-70`），纯恒等。
17. `member.joined/left` 在会话创建时发出，web 渲染为零信息量 notice。

## 3. 第一性原则

1. **用户世界的本体是 Message + 游标。** 1:1 会话里跨进程需要传递的是：消息（含 role 判别）与 seq（续传/undo/fork 定位）。LedgerEntry 是实现这两个东西的存储机制，不是领域本体，不作为 wire 契约。
2. **authorship 归 role，participation 归 conversation.agentId。** 1:1 里"谁参与"是常量（1 agent + 人类），参与关系塌缩为 thread 上的一个外键；"谁写的"由 message.role 判别。member 作为独立概念（身份行 + 合成 id + kind 判别）是群聊的参与抽象，信息量为零。
3. **append-only seq 日志保留。** conversation_ledger 的 seq/undo/fork/replay/search 能力以近乎零代码白送，换存储是大爆炸零收益。本 spec 只把它逐出公共契约，不动其存储机制。
4. **身份不可自报。** 服务端从会话成员推导 sender 与路由目标；客户端不再断言自己无法负责的身份事实。
5. **不兼容群聊旧机制。** mention cascade、wake routing、member notices、可见性过滤不设 fallback，随概念删除。

## 4. 终态

```text
wire:    ConversationEvent { seq, kind, message?, payload? }   ← 服务端已 parse；role 判别
API:     POST /messages { content, mode?, model? }              ← sender/路由服务端推导
         （senderMemberId/addressedTo 保留为可选显式覆盖，仅 lark 群聊在用，见 §6）
存储:    conversation_ledger 照旧（append-only seq 机制原样保留）
         conversation.agent_id 新列（FK 语义）
         member 表删除；agent_context_tree 单键 conversationId
         agent_run.agent_member_id → agent_id
删除:    packages/conversation 包
         member.joined/left ledger kinds + web notices
         resolveTriggerTargets / mention cascade / wake routing / 可见性过滤
         LedgerKind "todo"、TriggerMode "all"
```

## 5. 三刀切分（每刀独立可交付，落地后全绿）

### 5.1 刀 1 —— wire 契约塌缩 + 删包（无 schema 变更）

1. **SSE DTO**：`packages/api-contract/src/sse.ts` 定义
   ```ts
   const ConversationEvent = z.object({
     seq: z.number(),                                  // 游标 + undo/fork 定位
     kind: z.enum(["message", "member.joined", "member.left", "undo", "surface.control"]),
     message: MessageRevisionSchema.optional(),        // kind=message 时，服务端已 parse
     payload: z.unknown().optional(),                  // undo {undoneSeqs} / notices
   });
   ```
   `conversationEvents` map 改挂此 schema（SSE 事件名与 seq 语义不变；heartbeat 条目 seq=0 原样透传）。
2. **服务端出口**：conversation service 的 `#appendAndBroadcast`/subscribe 序列化处把 `content` parse 后装进 `message`/`payload`。一处出口，三个消费者受益。
3. **LedgerEntry zod 下线**：schema + parse/safeParse 移入 `apps/backend/src/features/conversation/`（存储 codec 是 backend 私事）。
4. **删包**：`@chengchenccc/conversation` 删除。`Member` zod 暂迁 `api-contract`（刀 1 期 API 仍返回 members 数组），`resolveTriggerTargets` 迁 backend service。死导出（§2.14）不迁，直接删。
5. **POST /messages**：`senderMemberId`/`addressedTo` 变 optional；缺省时服务端推导：sender = 会话唯一 human member，targets = 全部 agent member。web 停发两参数（顺带关闭 §2.12 冒充向量）；lark p2p 停发；lark 群聊 @mention 继续显式传（见 §6）。
6. **web**：reducer 按 `message.role` 归属（user→viewer 侧 / assistant·tool→agent 侧 / system→system notice），`parseMessageRevision` try/catch 删除（zod 已在 typedSource 校验）；`resolveAddressedTo` 删除；replay 不再回传 addressedTo；`ConversationEvent` 消费替换 `LedgerEntry`。
7. **lark**：`sse-watcher.ts` 改消费 `ConversationEvent`，删除 parse 舞步。

### 5.2 刀 2 —— member → conversation.agentId（schema migration）

1. **Migration**（手写 SQL，**多条语句必须 `-- statement-breakpoint` 分隔**）：
   - `conversation.agent_id` 新列，从 member 表 kind='agent' 行回填；loop/cron 的合成 agentId（"default" 等）原样回填（FK 约束放宽，容忍历史行无 agents 记录）。
   - `agent_context_tree` 去掉 `agent_member_id` 键：存量按 conversationId 去重（1:1 下无双树冲突），唯一键改为 `conversationId`。
   - `agent_run.agent_member_id` → `agent_id`（值回填：经 member 表 join 一次）。
   - `member` 表删除。lark human 绑定（`userRef "lark:*"`）迁 lark surface 自有表（lark-bot 已有 delivery/binding 表，读侧本就不依赖 core member）。
2. **backend**：`resolveRunConfig`/`resolveAgentEnabled`/`resolveWorkspace` 签名改收 `agentId` 直查 agents 表，三个 member join 删除；busyGuard 改 `WHERE agent_id = ?` 直查；tree/run/branch 全链路 agentMemberId 改 agentId；hopCount 语义改按 role（user→reset，assistant→+1）。
3. **API**：`POST /conversations` 的 members 数组改为 `agentId` 单值；`GET /conversations/:id` 返回 agent 信息（agents 表 join）；members 子资源路由删除。
4. **web**：roster 概念删除，`SenderRef` 由 role + agents 表信息构成；`RosterList` 退化为 agent 信息卡；viewer = role user（web 侧恒真）。
5. **member.joined/left**：kinds 从 DTO 枚举删除，addMember/removeMember 及 notices 链路删除。

### 5.3 刀 3 —— 群聊残留清理

1. `resolveTriggerTargets` 删除（web 路径已恒等；lark p2p 已服务端推导）。
2. `cascadeMentionedAgents`（mention 级联，`features.ts:388`）删除。
3. 可见性过滤删除：agent 上下文组装与 product-tools `history_recent` 的 eligibility 收敛为 `kind="message" && !undone && visibility !== "internal"`。
4. `TriggerMode` 类型与列、`"all"` wake 分支删除（列删除走 migration，默认值一并清理）。
5. `docs/architecture/*` 与 `CONTEXT.md` 同步：member/ledger 术语从 surface 叙事中清除。

## 6. 明确不做 / 开放决策

- **lark 群聊 @mention 路由**：唯一仍在消费显式 `addressedTo` 的路径（`ingest.ts:152-157`）。本 spec 保留 API 的可选显式覆盖参数作为其后门，**群聊形态是否裁撤是独立产品决策**，不在本 spec 强推。若裁撤，刀 3 追加删除可选参数。
- **存储引擎更换**：conversation_ledger 的 append-only seq 机制原样保留（第一性原则 §3.3）。
- **多 agent 会话回归**：不做任何兼容 shim。将来若产品重启多 agent，按新需求重新设计，不复活 member。

## 7. 验收清单

### 概念验收

- [ ] 全仓（web/lark/api-contract）无 `LedgerEntry`/`ledger` 术语的消费；SSE 消费者只认识 `ConversationEvent`。
- [ ] `@chengchenccc/conversation` 包不存在；`bun.lock`/turbo/commitlint scope 同步清理。
- [ ] 全仓无 `agentMemberId`/`memberId` 标识符（backend 内部、web、lark、测试）。
- [ ] `member` 表不存在；`conversation.agent_id` 存在且非空（历史合成 id 允许无 agents 行）。
- [ ] POST /messages 无客户端身份参数为必填；web/lark p2p 请求体不含 senderMemberId/addressedTo。

### 行为验收

- [ ] web 会话：发送→SSE 回显→agent 回复→undo 灰显→fork/replay，全链路行为与改造前一致（e2e `conversation-lifecycle.test.ts` 通过）。
- [ ] 断线重连：Last-Event-ID/afterSeq 续传语义不变（seq 仍是游标）。
- [ ] loop/cron 会话：owner agent 正常 spawn，工作区/项目绑定（ADR 0023）行为不变。
- [ ] lark p2p：消息触发 run、流式卡片、terminal 投递不变。
- [ ] busyGuard：同 agent 跨会话互斥语义不变（改直查后用现有测试覆盖）。
- [ ] migration 对存量库：老库升级后历史会话可读、seq 连续、undo/fork 目标不漂移。

### 边界测试

- [ ] api-contract 不再依赖 conversation 包。
- [ ] web/lark 不 import backend 内部类型（类型防火墙不破）。
- [ ] 心跳条目（seq=0 `_heartbeat`）在新 DTO 下不进消息列表。

## 8. 风险

| # | 风险 | 处理 |
|---|------|------|
| 1 | 刀 2 migration 回填错误（agent_id 空、tree 去重冲突） | 迁移后断言脚本：`SELECT count(*) FROM conversation WHERE agent_id IS NULL` 必须为 0；tree 唯一键迁移前先检测重复（1:1 下理论为零，异常即停） |
| 2 | 手写 SQL 多语句静默丢语句（历史上发生过） | 全部语句 `-- statement-breakpoint` 分隔；迁移后直接 sqlite3 断言表结构（`PRAGMA table_info`），不信 journal 存在性 |
| 3 | web Eden 类型滞后（backend dist 未重建） | 顺序固定：backend typecheck → backend build → web typecheck |
| 4 | lark 群聊显式参数与推导默认的歧义 | 推导仅发生在参数缺省时；显式传入优先。lark 群聊路径在刀 1 后回归测试锁定 |
| 5 | loop/cron 合成 agentId 无 agents 行，FK/查询歧义 | `agent_id` 不加硬 FK 约束；resolver 对无 agents 行回退现行默认（enabled=true、默认 workspace），与现行为一致 |
| 6 | 三刀期间 cherry-pick 交叉 | 每刀独立 commit 序列，spec 落地按刀推进，不并行 |

## 9. 关联

- M17.1（`2026-06-16-m17.1-message-model-boundary-refactor.md`）：MessageRevision 下压的下半场；本 spec §4 的 wire DTO 是其 §7.2 "appendMessageRevision/subscribeMessages 业务语言出口" 的实现。
- `docs/architecture/e2e-contract-rules.md`：ConversationEvent 归 api-contract 的依据。
- ADR 0023（project worktree）：刀 2 后 resolveWorkspace 直收 agentId，项目绑定逻辑不变。
