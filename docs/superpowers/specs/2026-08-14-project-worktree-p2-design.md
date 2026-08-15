# Project Worktree P2(Loop worktree 切换 + 合流)

- 日期:2026-08-14
- 状态:已批准(brainstorming 完成;范围 A+B、LOOP.md 指定 agent、页内 FF+Merge)
- 分支:`feat/project-worktree`(续 P1)
- ADR:`docs/adr/0023-project-worktree-workspace.md` §6 P2 行;P1 spec:`2026-08-14-project-worktree-p1-design.md`

## 1. 目标与非目标

**目标**
- **B(Loop 切换)**:LOOP.md 顶层 `agent: <agentId>`(缺省 `default`);loop 的所有 run 在该 agent 的 (agent, project) worktree 上执行;`resolveRepoPath` 的每 step 浅 clone(`dataDir/repos/`)退役。
- **A(聚合 + 合流)**:`/team/projects/[id]` 聚合页——attached agents 的分支状态(ahead/behind)、diff 视图、页内 Fast-forward / Merge(可带 push)。

**非目标**
- PR 流、远端凭证管理(首版限本地/公网可达 repo,ADR 既定)、evaluator 独立分支、worktree GC、输入级 projectId 覆写(P1 已明确后置)。

## 2. B:Loop worktree 切换

### 2.1 LoopConfig 增 agent 字段(packages/loop)

```typescript
export interface LoopConfig {
  projectId: string;
  /** The agent whose (agent, project) worktree runs this loop's steps.
   *  Empty string = "default" (back-compat). */
  agent: string;
  generator: { model: string; systemPrompt: string };
  // ...(rest unchanged)
}
```

- `parseLoopConfig`:`agent: String(frontmatter.agent ?? "default")`;写入侧(loop-service `writeDefaultLoopMd` + create API body)同步加可选 `agent` 字段。
- `gen.model === eval.model` 等现有校验不动;`agent` 不校验存在性(loop 层无 agent 概念,backend 层负责)。

### 2.2 resolveLoopWorktree(loop-step.ts 替换 resolveRepoPath)

```typescript
/** Resolve the loop agent's (agent, project) worktree and fast-forward it
 *  to the project's default branch (clean start per step, mirroring the
 *  retired per-step clone's semantics). */
export async function resolveLoopWorktree(
  loopConfigPath: string,
  deps: { projectPort: ProjectPort; dataDir: string; agentWorkspaceOf: (agentId: string) => Promise<string | null> },
): Promise<string | null>
```

- 读 LOOP.md → `projectId` + `agent`;project 无 repoUrl → throw(现有文案保留)。
- `agentWorkspaceOf(cfg.agent)` 解析 agent workspace(注入 `agentSvc.getById`;agent 不存在 → throw 指明 `LOOP.md agent "<id>" not found`)。
- `ensureMirror(dataDir, project)` + `ensureWorktree(mirror, agentWs, project, agentId)`(P1 函数直接复用;worktree 槽位被占 → null → throw 指明)。
- **每步干净起点**(替换 clone+reset 语义):
  ```bash
  git -C <wt> reset --hard refs/heads/<defaultBranch>   # mirror 刚 fetch 过,引用即远端最新
  ```
  defaultBranch 空 → `refs/remotes/origin/HEAD` 解析(一次 `git symbolic-ref`,失败则 throw)。
- 返回 worktree 路径;loopStepImpl 内 `cwd` 全部改用它。**旧 `resolveRepoPath` 函数体删除**(含 `dataDir/repos/` 常量),签名同步改名。

### 2.3 run 绑定与 member 路由

- `ensureLoopScope(conv, genConvId, genMemberId, cfg.agent)`(现在是硬编码 `"default"`,loop-step.ts:390)——evaluator 的 scope 同样用 cfg.agent。
- `enqueueAndAcquire` 的 `workspace: {root: cwd}` 不变(cwd 已是 worktree)。
- selective rollback(`git.resetHard` / checkoutFiles / removeFiles)作用于 worktree——函数不动,调用点 cwd 已换。

### 2.4 兼容与迁移

- 存量 LOOP.md 无 `agent` 字段 → 解析为 `"default"`,行为 = P1 的 default agent worktree。**无数据迁移**(旧的 `dataDir/repos/<id>` 目录成为孤儿,不主动删——操作员手动清;bootstrap 打一行 info 提示路径)。

## 3. A:worktree 聚合 + 合流

### 3.1 后端(`features/project/worktree-ops.ts` 新文件 + http.ts 挂路由)

```typescript
/** Read/merge operations over a project's agent worktrees. All git runs in
 *  the bare mirror (plumbing) — never in a live worktree (a run may hold it). */
export function createWorktreeOps(deps: {
  dataDir: string;
  projectPort: ProjectPort;
  listAgentConfigs: () => Promise<Array<{ id: string; workspacePath: string; projects: string[] }>>;
}): WorktreeOps;

export interface WorktreeStatus {
  agentId: string;
  branch: string;                  // agent/<aid>/<pid>
  ahead: number;                   // vs defaultBranch
  behind: number;
  worktreeReady: boolean;          // path exists
}

export interface WorktreeOps {
  status(projectId: string): Promise<WorktreeStatus[]>;
  diff(projectId: string, agentId: string): Promise<string>;   // defaultBranch...branch
  fastForward(projectId: string, agentId: string, opts: { push: boolean }): Promise<void>;
  merge(projectId: string, agentId: string, opts: { push: boolean }): Promise<void>;
}
```

- **status**:`git -C mirror rev-list --left-right --count <base>...<branch>`;attached agents 从 `listAgentConfigs` 过滤 projects 含 pid。
- **fast-forward**:先 `rev-list --count <base>..<branch>` 确认 base 无分叉(behind-only)→ `git -C mirror branch -f <defaultBranch> <branch>`;分叉 → 409。
- **merge**:`git -C mirror merge-tree <base> <branch>` 预检(bare 环境无工作区)——零冲突才 `branch -f`;有冲突 → 409 + 冲突文件列表(merge-tree 输出解析 `+<<<<<<<` 标记)。bare mirror 不支持 `git merge`(无工作区),合流以 branch -f + merge-tree 预检实现,语义 = base 前移到 branch(含合并结果时需先在临时 worktree 真合并——**首版不做真合并**,见 §3.2)。
- **push**:成功后 `git -C mirror push origin <defaultBranch>`;失败 422 + git stderr 摘要(不回滚本地前移——操作员决定;文案说明)。
- **错误**:project 无 repoUrl/agent 未 attach → 400/404 系沿用。

### 3.2 合流语义的诚实边界(写进 API 文档注释)

`branch -f` 只做「base 移到 branch tip」。两个 agent 分支各有新提交时(base 同时 behind 两者),谁的 branch 都不能直接 -f——**真两方合并首版不做**。merge 端点此时返回 409 `diverged; merge both branches manually`。页内 Merge 按钮仅在「单分支领先」场景可用(与 FF 等价);这是产品简化,不是实现偷懒,升级路径:临时 worktree 真合并后 -f。

### 3.3 HTTP(挂 project http.ts)

```
GET  /api/projects/:id/worktrees                     → { worktrees: WorktreeStatus[] }
GET  /api/projects/:id/worktrees/:agentId/diff       → { diff: string }
POST /api/projects/:id/worktrees/:agentId/fast-forward  body { push?: boolean }
POST /api/projects/:id/worktrees/:agentId/merge         body { push?: boolean }
```

### 3.4 前端 `/team/projects/[id]` 聚合页

- 头部:project 信息(name/repoUrl/defaultBranch)+ 该 project 的 Loops 列表(现有 loop 列表过滤 projectId)。
- 主体:worktree 卡(复用 ListRowCard)——agent 名、分支 mono、ahead/behind 徽章(仅 ahead>0 时亮 ok 色)、worktreeReady 警示、展开 diff(前 200 行 + 截断提示)、FF/Merge 按钮(confirm 走现有 confirm 模式 + push checkbox)。
- 空态:无 attached agents → EmptyState 指向 agent 详情页。
- `/team/projects` 列表行加「N agents」徽章 + 点击进聚合页。

## 4. 数据流(Loop 一步)

```text
cron/手动 → loopStep
  → parseLoopConfig: projectId + agent
  → resolveLoopWorktree: mirror(ensure) → worktree(ensure) → reset --hard <default>
  → Generator run: cwd=worktree, context=agent workspace
  → Evaluator run: 同 worktree 只读
  → verdict → selective rollback(resetHard/checkoutFiles 于 worktree)
聚合页 → status/diff(读 mirror)→ FF/Merge(bare 内 branch -f + 可选 push)
```

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| LOOP.md agent 不存在 | loopStep throw,现有 scheduler 重试/告警路径 |
| worktree 槽位被占 | throw 指明路径;聚合页 worktreeReady=false 警示 |
| FF 时 base 已分叉 | 409 `diverged` |
| merge-tree 报冲突 | 409 + 冲突文件列表 |
| push 失败 | 422 + stderr 摘要;本地 base 已前移,文案说明如何手动回退(`branch -f <base> <旧sha>`,响应附旧 sha) |
| reset --hard 失败(脏 worktree 被外进程锁) | loopStep throw → 现有重试 |

## 6. 测试

- **resolveLoopWorktree**(真 git fixture):agent 字段路由到对应 agentWs;default 兼容;每步 reset(defaultBranch 引用);agent 不存在 throw;旧 clone 路径不再产生。
- **worktree-ops**(真 git fixture):status 计数;FF 成功/分叉 409;merge 冲突 409 + 文件列表;push 开关(mock origin = 本地 file:// repo)。
- **loop-step 集成**:现有测试的 repo fixture 改为 worktree 路径断言;rollback 语义回归(baseSha reset)。
- **HTTP**:四端点 happy path + 409/422(沿用 project http 测试模式)。
- **前端**:audit 断言一条 `/team/projects/[id]` 渲染 worktree 卡容器。

## 7. 验收清单

- [ ] LOOP.md `agent` 字段路由 worktree;无字段 = default 兼容
- [ ] `grep -rn "dataDir/repos\|resolveRepoPath" apps/backend/src` 零命中
- [ ] Loop step 在 worktree 上跑通(集成测试,含 rollback)
- [ ] 聚合页:status/diff/FF/merge 真机走通(本地 file:// repo)
- [ ] push 开关生效且失败可恢复(422 响应含旧 sha)
- [ ] 全仓 typecheck/lint/test 绿 + audit 15/14+1 绿
