# ADR 0003: Agent Workspace 布局 + 资源桥接(bridge)

## 状态

Accepted

## 上下文

多 coding-agent backend(coding_agent / claude / pi / omp)落地后,每个 agent 需要:

1. 一个**可配置的运行工作区**——omp/pi/claude 这类 coding agent 以工作区为 cwd,读取其中的 `AGENTS.md`/`CLAUDE.md` 才生效;当前 workspace 是自动物化(`<dataDir>/agents/<id>`),用户无法指向自己准备好的目录。
2. 工作区内**每类 coding agent 的项目级配置目录**(`.agent`/`.pi`/`.omp`/`.claude`)。
3. 资源供给(skill / knowledge / mcp)以"**后端存一份、按开关桥接到指定 agent 工作区**"的方式分发——即一个可复用的 **bridge** 能力,而非每种资源各写一套拷贝逻辑。
4. 自研 coding_agent 与 pi/omp 定位一致,skill 也应同构处理(读 `.agent/skills/`)。
5. 当前 seed 会创建 `default` 与 `loop-agent` 两个 agent,loop 其实不需要独立 agent 行。

Gate 0 与 ADR 0002 已核实:omp/pi/claude 在 cwd 读项目级配置;`--session`/`-r` 续接上下文;fork 是 conversation 级(无 branch 级 fork)。

## 决策

**1. agent.yml 为唯一真源(file-first),workspace 可配置**
- `agent.yml` 承载 agent 全部可移植配置(见 §2 布局):`name`/`title`/`description`/`runtime_config`(runtime/model_id/reasoning_effort/permission_mode/max_steps)/`lark`(enabled/app_id/bot_display_name/profile_ref)。`appSecret` 不持久化(现状)。
- `agents` 表**删内容列**(name/modelProvider/modelName/backendKind/reasoningEffort/permissionMode/maxSteps/lark*),只留 `id`(FK 锚)、`workspacePath`、`archivedAt`、时间戳 + 一个 `config` 物化缓存(解析后的 agent.yml,运行时读它,不改消费者)。
- 写路径:API 或用户手改 agent.yml → 后端解析 + zod 校验 → upsert DB 缓存;读路径读缓存(快/可 join/事务)。
- `workspacePath` 用户可配(绝对路径,`mkdir -p`,默认 `<dataDir>/agents/<id>`);`unique` 防撞目录;下游(identity/memory)改读 `agent.workspacePath`。

**2. workspace 布局**(seed 幂等,不覆盖用户编辑)
```
<workspace>/
  agent.yml            # 描述符(agent-hub 预留口)
  AGENTS.md            # 指令 + 知识库跨文件引用
  manifest.json        # 机器清单(agent-hub 预留口)
  SOUL.md              # 身份(identity store)
  USER.md              # 用户上下文(identity store)
  memory/              # agent 记忆(identity store)
  knowledge/           # 知识库(项目使用说明等)
  .agent/skills/       # 自研 coding_agent 项目级配置
  .pi/skills/          # pi
  .omp/skills/         # omp
  .claude/skills/      # claude
```
四个配置目录**全部创建**(便宜占位,切 kind 无缝)。AGENTS.md 含:
```
## 知识库
需要本项目使用说明、领域知识或约定时,先读 knowledge/ 下相关文件再作答。
```

**agent.yml schema**(唯一真源,见 §1):
```yaml
# agent.yml — agent 便携配置的唯一真源(DB 只存锚点 + 缓存)
schema_version: "1"
enabled: true
id: <agentId>
name: <机器名,唯一>
title: <显示名>
description: ""
runtime_config:
  runtime: coding_agent        # coding_agent | claude | pi | omp
  model_id: provider/model
  reasoning_effort: ""         # none|low|high|max|""
  permission_mode: ask         # ask|auto|deny
  max_steps: 0                 # 0 = 不限
lark:
  enabled: false
  app_id: ""
  bot_display_name: ""
  profile_ref: ""              # 服务端生成,后端回写
```

**manifest.json schema**(bridge reconcile 重写的资源索引,不含身份):
```json
{
  "schema_version": "1",
  "files": ["agent.yml", "AGENTS.md", "SOUL.md"],
  "skills": [],
  "knowledge": [],
  "mcp": []
}
```

**3. Workspace bridge(抽象为一个 feature)**
- **源(单点真理,在 `dataDir` 下)**:skill `<dataDir>/skill-packs/<packId>`;knowledge `<dataDir>/knowledge/<packId>`;mcp servers 为 DB 记录(现有 mcp feature)。
- **桥接(按 agent 分配开关)**:资源经软链/写文件落到 agent workspace:
  - skill → `<workspace>/.<kind>/skills/<packId>`(软链整个 pack 目录)
  - knowledge → `<workspace>/knowledge/<packId>`(软链)
  - mcp → `<workspace>/.<kind>/mcp.json`(写入配置)
- **幂等 reconcile**:增补缺失、清理 stale 软链;触发点为 agent 创建/更新(kind/workspace 变更)、pack install/sync/assign、mcp server 增改/分配。

**4. 自研 coding_agent 与 pi/omp 一致处理 skill**
- child 从 cwd 读 `.agent/skills/`(软链指向 skill-pack 安装目录),与 pi/omp/claude 读各自配置目录同构;skill 供应完全走 bridge,不再走 `run.skillRoots` 传参。
- 契约变更:`BackendRunInput.run.skillRoots` 废弃/移除,progressive-skill 插件改为扫 cwd 的 `.agent/skills/`。

**5. 去掉 loop-agent**
- 只 seed `default`(Assistant);loop generator/evaluator 的 member `agentId` 从 `"loop-agent"` 改为 `"default"`(loop 的 model/workspace 来自 LOOP.md 显式配置,不依赖 agent 行身份)。

**6. meta 与历史也对齐:所有 coding agent 统一为「cwd 文件 + session 续接」**
- meta(身份/配置/技能/产品工具/知识库)统一由工作区文件承载(见 §1–§3),所有 agent 从 cwd 原生读——后端不再经 run 输入字段或 CLI flag 注入。
- 历史也统一:所有 agent 用 **CLI session** 续接 + 分支首轮 flat-text 桥(把产品投影拍平喂一次);**全量投影退役**。
- run 输入瘦身为 `runId / model / workspace / message`;删 `history` / `systemPrompt` / `skillRoots` / `productTools` 四字段。
- **修正 ADR 0002**:取消"coding_agent = 全量投影、CLI = session"的双轨特例,统一为单轨(CLI session 是运行态真理,context tree 是产品态真理,对所有 agent 一致)。
- 自研 coding_agent 加 session 持久化(会话文件,同 pi/omp 的 JSONL 或更简),child 读 `AGENTS.md`/`SOUL.md` + 扫 `.agent/skills/` + 读 `.agent/mcp.json`。
## 后果

- 新 feature:`features/agent/workspace-bridge.ts`(或独立 `workspace-bridge` feature)——skill/knowledge/mcp 三类资源的桥接与 reconcile。
- seed 从"仅 SOUL/USER"扩展为完整布局;materializeWorkspace 幂等 seed。
- file-first 迁移:agents 表删内容列(迁移 N+1),加 `config` 物化缓存列;agent.yml 解析器 + zod 校验 + 写后 upsert 缓存;所有 `agentModelRef`/`resolveDefaultModel` 读缓存列(消费者不改签名)。
- coding_agent child 改从 `.agent/skills/` 发现技能;`run.skillRoots` 契约移除,progressive-skill 插件改扫 cwd。
- 统一上下文:run 输入删 history/systemPrompt/productTools;coding_agent 加 session 持久化;ADR 0002 双轨改单轨,ADR 0017 + CONTEXT.md 不变量 9 重写。

## 关联

- [ADR 0002: CLI Session 双轨真理](./0002-cli-session-dual-truth.md)
- [Gate 0 协议核实](../architecture/execution/backend-kinds-gate0.md)
- [设计哲学](../architecture/design-philosophy.md) — 单点真理 + 显式边界(资源一份,桥接分发)
