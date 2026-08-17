# Project Worktree P1(agent-project 多对多桥接)

- 日期:2026-08-14
- 状态:已批准(brainstorming 完成;attach 入口 = file-first,run 绑定 = 会话级)
- 分支:`feat/project-worktree`
- ADR:`docs/adr/0023-project-worktree-workspace.md`(本 spec 是其 P1 落地)

## 1. 目标与非目标

**目标**
- agent.yml 声明 `runtime_config.projects: [projectId]`(file-first 多对多)。
- (agent, project) 对 materialize 一个 git worktree 到 `<agentWs>/projects/<id>/`,共享 bare mirror `<dataDir>/projects/<id>.git`。
- bridge 把 `.mcp.json` + `.oma/product-tools.json` 写进 worktree(修 product tools 在非默认 cwd 场景的断裂)。
- conversation 可选携带 projectId;该会话的 run cwd = worktree,context 仍来自 agent workspace。
- 删除 `autoOrchestrate` 死字段(全链 17 处)。

**非目标(P2)**
- 输入级 projectId 覆写;合流动作(fast-forward/merge UI);Loop 每 step 浅 clone 切换为常驻 worktree;mirror 定时同步;worktree 悬空 GC。

## 2. 组件

### 2.1 `apps/backend/src/features/project/worktree.ts`(新)

```typescript
/** Git plumbing for (agent, project) worktrees. All operations are
 *  idempotent; failures throw with the underlying git stderr. */
export interface WorktreeProject {
  readonly projectId: string;
  readonly repoUrl: string;
  readonly defaultBranch: string | null;
}

/** Ensure the shared bare mirror exists and is fresh (clone --mirror on
 *  first attach; fetch --prune afterwards). Safe under concurrent calls:
 *  clone writes to `<id>.git.tmp` then renames; a stale .tmp is removed. */
export function ensureMirror(dataDir: string, project: WorktreeProject): Promise<string>;

/** Ensure the agent's worktree exists at `<agentWs>/projects/<projectId>/`
 *  on branch `agent/<agentId>/<projectId>` based on the project's
 *  defaultBranch (mirror HEAD when null). No-op when already present.
 *  Returns the worktree path. */
export function ensureWorktree(
  mirrorPath: string,
  agentWorkspace: string,
  project: WorktreeProject,
  agentId: string,
): Promise<string>;

/** Detach the worktree and delete its branch (detach path). */
export function removeWorktree(
  mirrorPath: string,
  agentWorkspace: string,
  project: WorktreeProject,
  agentId: string,
): Promise<void>;
```

- 实现用 `Bun.$`(与 loop-step 的 git 调用同风格),git 二进制即依赖。
- `ensureWorktree` 的「已存在」判定:`git worktree list --porcelain` 里含该路径即 no-op(不校验分支名,避免误删用户改名后的分支)。
- 用户自有目录占据 worktree 槽位时:跳过 + 返回 null + 调用方 warn(与 bridge 的「不覆盖用户文件」纪律一致)。

### 2.2 agent-config(多对多声明)

`agentConfigSchema.runtime_config` 增:

```typescript
projects: z.array(z.string().min(1)).default([]),
```

- `buildAgentConfig` 的 input/prev 回退与 `serializeAgentYaml`/parse 同步(mcp_servers 同构)。
- 迁移 0032(手写,`--> statement-breakpoint` 分隔,when 严格递增):`ALTER TABLE conversation ADD COLUMN project_id TEXT REFERENCES project(project_id) ON DELETE RESTRICT;`
- agent.yml 文件里字段名 `projects`(与 knowledge_packs 命名风格一致,不带 _packs 后缀——它引用的是 project id)。

### 2.3 reconcile(features.ts + workspace-bridge)

`reconcileAgent.fn` 在现有 skills/mcp/knowledge 之后:

```text
for projectId of agent.config.runtime_config.projects:
  project = projectSvc.getById(projectId)       // 不存在:console.warn,continue
  mirror = await ensureMirror(dataDir, project)
  wtPath = await ensureWorktree(mirror, agent.workspacePath, project, agentId)
  if (wtPath):
    writeMcpConfig(wtPath, <与主 workspace 相同的 server 列表>)
    writeProductToolsManifest(wtPath, <相同 manifest>)
```

- detach(声明里移除某 project):reconcile 对比上一版(从 DB config 缓存的旧 projects)→ `removeWorktree`。首版用简单差集;缓存缺失时跳过清理(warn)。
- reconcile 失败永远不炸 agent 更新(与现有 skill/mcp 桥一致:catch + warn)。

### 2.4 conversation 会话级绑定

- 创建 API body 增 `projectId?: string`(校验存在);`ConversationRow`/ports/adapter 跟随。
- `resolveWorkspace`(features.ts):conversation.projectId 非空时 →
  1. 查 agent 是否声明该 project(声明 → worktree 路径,`access` 沿用 permission_mode 推导);
  2. 未声明 → throw(走 dispatch 既有失败路径:run failed + status event 带 error 文案「agent X 未 attach project Y,先在 agent 详情勾选」)。
- GET /api/conversations/:id 响应带 `projectId`。

### 2.5 死字段删除

`autoOrchestrate` 17 处:schema 列 + select transform + domain 三处 + service create/update/patch + http body + adapter 映射。迁移 0032 同文件内第二条语句 `ALTER TABLE project DROP COLUMN auto_orchestrate;`(与 add 同文件,breakpoint 分隔)。

### 2.6 web

- `/team/agents/[agentId]` 详情:Projects 区(多选 toggle 列表,数据 = listProjects + agent.config.projects;mutation = PATCH projects)。
- `/chat` 新建会话:可选 project 下拉(有 projectId 时提示「该会话的运行工作区 = project worktree」)。
- `/team/projects` 行:展示 attach 的 agent 数(查询:遍历 agents 的 config.projects)。

## 3. 数据流

```text
用户勾选 project(PATCH /api/agents/:id {projects})
  → agent.yml 重写 + DB 缓存 + reconcile
  → ensureMirror(首次 clone --mirror)+ ensureWorktree(分支 agent/<a>/<p>)
  → bridge 写 .mcp.json / .oma/product-tools.json 进 worktree
创建会话(POST /api/conversations {projectId})
  → 发消息 → run dispatch → resolveWorkspace
  → conversation.projectId + agent 已声明 → workspace.root = worktree
  → child spawn:cwd = worktree,context(skillRoots/prompt/token)仍来自 agent workspace
```

## 4. 错误处理

| 场景 | 行为 |
|---|---|
| attach 时 mirror clone 失败 | PATCH 返回 422(repoUrl/git stderr 摘要);agent.yml 已写入,reconcile 下次重试(warn) |
| worktree 槽位被用户目录占据 | 跳过 + warn;run 引用该 project 时 preflight 报「worktree 未就绪」 |
| conversation 引用未声明 project | dispatch 失败路径:run failed + error 文案指明 attach 方法 |
| 删除 project 仍有 attach | 409 + attach 的 agent 名单;先 detach 再删 |
| worktree 分支被用户删除 | 下次 reconcile 的 ensureWorktree 重建(git worktree add 分支不存在时 -b 重新创建) |

## 5. 测试

- **worktree.test.ts**:真实 git fixture(repo → mirror → worktree);幂等(双跑无副作用);detach 清理;槽位占据跳过。
- **reconcile 集成**(workspace-bridge.test.ts 扩展):attach 后 worktree 内 .mcp.json 存在且含 product-tools 条目;重复 reconcile 稳定。
- **execution**:conversation 带 projectId 的 run,fake daemon 断言 child cwd = worktree 路径;未声明 project 的 run 进 failed 且 error 含指引用语。
- **config**:projects 字段 round-trip(yaml 写读、PATCH 校验 400)。
- **E2E 冒烟**:真 repo(本地 file:// 即可)→ attach → 建会话 → 发消息 → 断言 run workspace.root 指向 worktree。
- **迁移**:fresh-boot 集成测试(现有 db.test 模式)+ autoOrchestrate 列消失断言。

## 6. 验收清单

- [x] agent.yml `projects` 声明 → worktree 落位 + bridge 文件存在(幂等)
- [x] 会话带 projectId 的 run cwd = worktree(context 不变)
- [x] 未声明 project 的 run 显式失败,错误可操作
- [x] detach 清理 worktree + 分支;project 删除被 attach 阻止
- [x] `grep -rn autoOrchestrate apps/backend/src` 零命中
- [x] 全仓 typecheck/lint/test 绿 + audit 14/14
