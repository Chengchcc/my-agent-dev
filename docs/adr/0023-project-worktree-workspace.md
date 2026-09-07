# ADR 0023: Project 多对多工作区(git worktree 桥接)

## 状态

Proposed

## 上下文

Project 现状是「孤岛 CRUD + 一个真实消费者」：

1. **唯一链路在 Loop**：LOOP.md 写 `projectId` → loop-step 找 project → 每 step `git clone --depth 1` 到临时目录 → 作为该 Loop 所有 Run 的 workspace(覆写 agent 默认 workspace)。
2. **Chat/手动 run 与 project 无关**：conversation 无 projectId；agent 的 cwd 永远是自己的 workspace，想让它操作某个 repo 只能靠对话里人肉贴路径。
3. **`autoOrchestrate` 是死字段**：注释说「reactor auto-advances issues」，reactor/issues 已随 ADR 0011 退役，零消费者。

更根本的：现有架构有一个**没有说破的裂缝——「角色记忆的家」和「干活的 cwd」是同一个东西**(workspace.root)。Loop 绕过了它(直接换 cwd)，代价是 clone 里没有 agent 的任何资源桥：`.mcp.json`、`.oma/product-tools.json` 都不在，CLI 后端的 product tools 在 Loop 场景实际上是断的。

目标模型(用户裁决)：

- **Project ↔ Agent 多对多**：一个 project 可以被多个 agent 串行或并行操作；一个 agent 可以同时参与多个 project。
- **本质**：agent 底层的 oma 在自己 workspace 完成身份加载(persona/skills/knowledge/history)，然后**到 project 的 checkout 上 coding**，context 与 cwd 分离。
- 可选实现路径：`cd` 到共享 checkout，或 `git worktree` 到 agent workspace 子目录。

## 决策

**采用 git worktree 方案：每个 (agent, project) 对一个 worktree，挂在 agent workspace 的子目录下。**

### context 与 cwd 分离(修正 ADR 0020 的隐含假设)

ADR 0020 的「workspace 即 cwd」只对**无 project 参与**的 run 成立。协议无需改动，`BackendRunInput` 已经天然分立：

| 通道 | 内容 | 来源 |
|---|---|---|
| `workspace: {root}` | cwd(干活的地方) | 无 project → agent workspace；有 project → 该 (agent, project) 的 worktree |
| `skillRoots` / systemPrompt / productToolsToken | context(我是谁) | 永远来自 agent workspace |

「context 来自 workspace、cwd 指向 worktree」不需要新协议字段，只需要改 dispatch 的 workspace 绑定逻辑。

### 为什么是 worktree 而不是共享 checkout 的 cd

| | cd 到共享 checkout | git worktree 到 workspace 子目录 |
|---|---|---|
| 并行(多 agent 同 project) | 互相踩工作区文件 | 天然隔离：一 worktree 一分支 |
| 与 agent 记忆共存 | 路径断裂，桥接文件无处安放 | `<ws>/projects/<proj>/` 与 context 同树 |
| 磁盘/速度 | 每 agent 重复 clone | 共享对象库，增量近零 |
| 审查/回滚 | 无归属 | 每 worktree 一条 branch → diff 可审、可选择性回滚 |

「一个 project 被多个 agent 操作」= 每 (agent, project) 一个 worktree、自己的分支(`agent/<agentId>/<projectId>`)，互不干扰，产物靠分支 diff 合流。这是 git 原生工作流，不发明锁协议。

### 布局与多对多声明

```
<dataDir>/projects/<projectId>.git        # 共享 bare mirror(N 个 agent 一份对象存储)
<agentWorkspace>/projects/<projectId>/    # 该 agent 的 worktree checkout
  .mcp.json                               # bridge 写入(product-tools + 用户 servers)
  .oma/product-tools.json               # bridge 写入
  ...                                     # repo 内容(git worktree)
```

- **多对多声明放 agent.yml**(file-first，不加关联表)：`runtime_config.projects: [projectId, ...]`。编辑 agent 或 PATCH API → bridge reconcile materialize/清理 worktree。
- **repo 镜像**：首次 attach 时 `git clone --mirror <repoUrl> <dataDir>/projects/<id>.git`；worktree `git worktree add` 从 mirror 切出，branch 基于项目 `defaultBranch`。
- **bridge 复用**：`writeMcpConfig` / `writeProductToolsManifest` 现有函数直接对 worktree 路径再调一次。这顺手修复 Loop 场景 product tools 断裂的问题(Loop 收编后同享此路径)。

### Run 绑定

- conversation 或 branch_input 携带 `projectId`(会话级默认 + 输入级覆写)→ dispatch 时 `run.workspace = {root: worktreePath}`，走现有 `run.workspace` 覆写通道(Loop 已在用，非新机制)。
- worktree 不存在(未 attach)时：preflight 失败，错误信息指明 attach 路径，不静默 fallback 到 agent workspace。

### 并发纪律

- **同一 (agent, project) 的并行 run 排队**(沿用 busyGuard 思路：branch 粒度已串行，(agent, project) 粒度同样处理)；不同 agent 的 worktree 互不阻塞，真并行。
- **分支命名 `agent/<agentId>/<projectId>`**：agent 内串行可 fast-forward 复用；需要隔离的场景(试验性 run)显式开临时 branch，run 结束合并或丢弃。

### 分阶段落地

| 阶段 | 内容 | 退役/迁移 |
|---|---|---|
| P1 | agent.yml `projects` 字段 + mirror/worktree materialize + bridge 写入 + run.workspace 绑定 + `/team/projects` 页关联 Loops/worktrees | 删 `autoOrchestrate` 死字段 |
| P2 | conversation 级 projectId + 前端「project → agents/branches/diff」聚合页；合流动作(fast-forward / 人审 merge) | Loop 的每 step 浅 clone 切换为常驻 worktree，loop-step clone 逻辑退役 |

## 后果

- **正面**：多 agent 并行协作一个 repo 成为原生能力；Loop 的 product tools 断裂被修复；「project 作为工作归属域」(ADR 0011)有了实体支撑；磁盘一份对象存储。
- **负面/成本**：
  - worktree 生命周期管理(删除 agent/project 时的清理、悬空检测)是新的运维面；
  - 合流策略是产品决策(先只做各自分支 + diff 可视，合并动作后置)；
  - mirror 的远端同步(fetch 策略、鉴权 repo 的凭证)需要单独设计，首版限公网/本地可达 repo。
- **不做的**：不加 project-agent 关联表(file-first 声明足够，查询走 reconcile 产物)；不发明跨 agent 锁协议(git 分支即边界)；不在本 ADR 内设计 PR/合流产品形态。

## 与既有 ADR 的关系

- 修正 [ADR 0020](./0020-agent-workspace-and-resource-bridge.md) 的「workspace 即 cwd」隐含假设，workspace 仍是**身份与资源的家**，cwd 可以是 worktree。
- 落地 [ADR 0011](./0011-web-ia-work-chat-team.md) 的「Project 作为工作归属域」定位。
- 与 [ADR 0021](./0021-one-conversation-one-agent-member.md) 正交：会话成员模型不变，project 是 run 的事实而非会话结构。
