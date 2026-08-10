# Phase 2：重写 Coding Agent

## 目标

将 `packages/agent` 重写为 Worker-local Coding Agent Runtime：一个 Agent Loop owner、一棵 Coding Session Tree、一套 Plugin/Tool/Prompt/ModelRuntime 边界。

这是破坏性重写。Phase 2 期间旧 Product Backend caller 可以暂时无法编译；不为旧调用链保留兼容层。

## 不兼容策略

删除：

- public `Agent` facade、AgentSDK、`createAgentSession()`、`SessionManager`；
- flat MessageStore、InterruptStore、durable `resume()`；
- AgentHooks adapter、旧 compatibility exports；
- Coding Session Tree 的 ModelChangeEntry；
- Product-owned runtime plugin 装配；
- 旧 session/checkpointer 读取；
- 旧事件名 alias。

## 约束

1. Agent Loop 是唯一 terminal/retry/queue owner。
2. System Prompt 不进入 Coding Session Tree。
3. Meta 每 Agent Loop 一次。
4. Retry 只处理 provider transient error，不追加输入。
5. Follow-up 新建 loop；steer 进入当前 loop 安全边界。
6. Worker crash 不恢复 active loop。
7. Runtime 不访问 Product DB、Ledger、Agent Context、Product Memory。
8. Product history 只通过 `ProjectedHistoryItem` 输入。

## 目标文件

重写：

```text
packages/agent/src/runtime/
packages/agent/src/persistence/
packages/agent/src/context/
packages/agent/src/index.ts
packages/agent/package.json
packages/ai/src/
packages/tools-common/src/
```

删除旧 facade/persistence/plugin exports；本 Phase 只修改 Coding Agent 自身 package 与 tests。Product Backend、Cron、Loop、Skill Pack 等业务 caller 统一在 Phase 5 迁移，不在本 Phase 提前切流。

## 实现步骤

1. 以 `runtime/span-loop.ts` mechanics 为基础建立单一 Agent Loop：model stream、tool batching、maxSteps、beforeStop veto、force continue、terminate hint、awaited listeners。
2. 定义 CodingSessionEntry：MessageEntry、CompactionEntry、TodoStateEntry；operation 只有 leaf_moved。
3. 定义 SessionStore：create/open/delete、appendBatch、moveLeaf、readBranch、findByProductEntryIds。
4. 实现 InMemory/SQLite store；每 session 一个 SQLite；entries+leaf operation+cache 同事务。
5. 原子写 loop input batch：projected history + one Meta + one Prompt。
6. Prompt：System 不入 Tree；Meta/Prompt 两条 user；beforeModel 无持久副作用；compaction 显式执行。
7. Plugin 只支持 hooks/tools/meta sections；静态加载；无动态 reload；Todo 为内置 entry。
8. ModelRuntime：Provider registry/catalog/credential/error normalization/stream dispatch。
9. Tools 使用 realpath containment；拒绝 traversal/symlink escape；web tools 走 ports。
10. Skills 扫 frontmatter，Meta 注入索引，skill_load 按需加载。

## 验收

- InMemory/SQLite 通过相同 SessionStore suite。
- appendBatch 原子；productEntryId 幂等；leaf cache 可重建。
- retry 不重复 Meta/Prompt/history。
- follow-up 新 loop；steer 不新 Meta。
- tool error 不触发 provider retry。
- overflow compaction 最多 retry 一次。
- listeners 完成后 loop 才 settled。
- crash 后 active loop 不恢复。
- System Prompt 不在 Tree；每 loop 恰好一条 Meta。
- context shaping 不写 store。
- Todo restart 恢复；Skill 正文按需加载。
- traversal/symlink escape tests 通过。
- credential 不进 Tree/event/log。
- Anthropic/OpenAI-compatible provider contract tests 通过。
- 旧 Agent/SessionManager/createAgentSession exports 不存在。

## 完成条件

Coding Agent Runtime core 能在单进程 harness 中执行完整 Agent Loop。旧 Runtime API 已彻底删除，没有兼容实现。
