---
id: agents.workspace-and-backends
title: Agent 工作区与多后端
status: current
owners: architecture
last_verified_against_code: 2026-08-13
summary: "Agent 的一切配置都是工作区文件(agent.yml/AGENTS.md/SOUL.md/USER.md/.<kind>/skills/.mcp.json/.agent/product-tools.json),backend 用 Workspace Bridge 幂等桥接。运行时四后端可切换:coding-agent/claude/pi/omp,各自原生 session 续接,产品只存 branch.cliSessionRef。一个对话 = 一个 Agent 的 session 产品态投影(ADR 0021)。"
depends_on:
  - architecture.system-overview
used_by:
  - runtime.coding-agent
---

# Agent 工作区与多后端

本页描述 2026-08 收敛后的**现行**模型:Agent 的配置住在工作区文件里;运行时四后端可切换;对话是单 Agent 的 session 投影。决策记录见 ADR 0019(双轨真理)、ADR 0020(工作区+桥接)、ADR 0021(单 Agent 投影)。

## 1. Agent 工作区即配置

每个 Agent 有一个工作区目录(`<dataDir>/agents/<id>`,可配置 absolute path),seed 布局:

```text
workspace/
  agent.yml              # 唯一真源(名字/模型/effort/permission/workspace)
  AGENTS.md / CLAUDE.md  # 通用行为约定(symlink)
  SOUL.md                # Agent 身份
  USER.md                # 用户偏好
  manifest.json          # 桥接索引(机器生成)
  knowledge/             # 知识库(seed,引用方式待产品化)
  .agent/skills/  .pi/skills/  .omp/skills/  .claude/skills/
                         # skill pack 软链,按当前 kind 桥接
  .mcp.json              # 用户 MCP server + product-tools 合并
  .agent/product-tools.json  # 产品工具 manifest(自研 child 读)
  memory/MEMORY.md  memory/facts/*.md   # 记忆(agent 自写)
```

- **file-first**:agent.yml 是描述符(人可手写),manifest.json 是桥接索引(机器生成);DB 只存 id/workspacePath/时间 + config JSON 缓存。
- **Workspace Bridge**(`apps/backend/src/features/agent/workspace-bridge.ts`):幂等 reconcile,skill 软链按 kind 建、.mcp.json 单一 writer、product-tools manifest 写入;触发点 = agent create/update、skill pack 安装/分配、mcp server 增删改。
- 人类可以直接编辑工作区文件;Web 的 Workspace tab 只读浏览(两条只读路由,resolve+realpath 防穿越)。

## 2. 四后端,统一 spawn 模式

| kind | 实现 | 原生配置读取 | session 续接 | 特有 flag |
|---|---|---|---|---|
| `coding_agent` | apps/coding-agent(rpc JSONL) | cwd meta(AGENTS/SOUL/USER + .agent/skills) | 自维护 `~/.my-agent/sessions/<id>.jsonl`(parentId 链,同 pi/omp 格式) | live steer/abort |
| `claude_code` | claude CLI | cwd 项目配置 + `--mcp-config` | `--resume <sessionId>` | `--effort` / `--permission-mode` |
| `pi` | pi CLI | cwd 项目配置 + pi-mcp-adapter | `--session <id>` | `--provider/--model` |
| `omp` | omp CLI | cwd `mcp.json` | `-r <id>` | `--thinking` |

- 每个 Run 由对应 adapter spawn 一次性子进程;coding_agent 用 stdin/stdout JSONL,CLI 用 argv+stdin。
- **session 不按 kind 建目录、不共享**:产品只存一个不透明引用(`branch.cliSessionRef`,run 输入透传 + outcome 回写);切 kind = 新 session。
- **run 输入已瘦身**(ADR 0020 决策 6 修订):删 history/productTools;保留 systemPrompt/skillRoots 作 run 级覆盖通道(Loop 作用域)。首轮上下文 = flat-text 桥(无 session ref 时由 backend 把投影拍平拼进 message)。
- **能力矩阵**:workflow(`run_workflow`/`workflow_run` 子代理扇出 + 脚本编排)是
  **coding_agent 专属**——执行器在 child 进程内(共享 model stream/工具/store)。
  CLI backends(claude/pi/omp)是薄适配器,无等价面:它们的编排面 = MCP 挂载的
  产品工具(history/todo)+ 各自原生工具,不提供 workflow,前端无事件即无卡片
  (天然降级)。产品功能(loop)锁 `coding_agent`,不受 agent kind 影响。
  跨 kind 的 workflow 唯一路径 = 产品侧编排(调度层 + 身份传播 + 结果回流),
  与"一次输入一个 run"的模型冲突,不做。

## 3. 一个对话一个 Agent(ADR 0021)

- conversation 是 coding agent 的 session 在 backend 上的**产品态投影**:形状对齐(一条 agent 线),**不是来源**——禁止从 session 重建 conversation(undo/pin/human 消息只在产品侧)。
- 一个 conversation = 一个 agent member;human 消息是外部事件。
- 多 Agent 协作 = 多个 conversation 投影到同一事情(work 级挂载,`thingRef` 待落地)。
- kind 切换:同一 conversation 内 fork 新 branch 标记断点(ADR 0019 决策 2),session 换新、上下文靠首轮文本桥。

## 4. 关键代码路径

- `apps/backend/src/features/agent/workspace.ts`(seed 布局)· `workspace-bridge.ts`(reconcile)· `agent-config.ts`(agent.yml zod+序列化)
- `apps/backend/src/features/agent-run/execution.ts`(buildRunInput:flat-text 桥 + cliSessionRef 透传 + outcome 回写)
- `packages/agent-backend/src/kinds.ts`(BACKEND_KINDS)· 四个 adapter 包
- `apps/coding-agent/src/core/workspace-context.ts`(cwd meta 读取)· `session-file.ts`(session 持久化)· `product-tools-manifest.ts`(cwd manifest)
- Web:AgentForm(kind 条件字段:claude 无 provider、pi 无 effort、pi/omp 无 permission)+ agent 详情 Workspace tab
