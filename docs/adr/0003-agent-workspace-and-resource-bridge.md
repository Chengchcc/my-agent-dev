# ADR 0003: Agent Workspace 布局 + 资源桥接(bridge)

## 状态

Accepted

## 上下文

多 coding-agent backend(coding_agent / claude / pi / omp)落地后,每个 agent 需要:

1. 一个**可配置的运行工作区**——omp/pi/claude 这类 coding agent 以工作区为 cwd,读取其中的 `AGENTS.md`/`CLAUDE.md` 才生效;当前 workspace 是自动物化(`<dataDir>/agents/<id>`),用户无法指向自己准备好的目录。
2. 工作区内**每类 coding agent 的项目级配置目录**(`.agent`/`.pi`/`.omp`/`.claude`)。
3. 资源供给(skill / knowledge / mcp)以"**后端存一份、按开关桥接到指定 agent 工作区**"的方式分发——即一个可复用的 **bridge** 能力,而非每种资源各写一套拷贝逻辑。
4. 自研 coding_agent 也要与 CLI backend 保持**布局统一**(哪怕机制暂不改)。
5. 当前 seed 会创建 `default` 与 `loop-agent` 两个 agent,loop 其实不需要独立 agent 行。

Gate 0 与 ADR 0002 已核实:omp/pi/claude 在 cwd 读项目级配置;`--session`/`-r` 续接上下文;fork 是 conversation 级(无 branch 级 fork)。

## 决策

**1. Agent workspace 可配置**
- `agents.workspacePath`(已有列)变为用户可配:agent 创建/编辑可填绝对路径 `workspacePath`;填了 `mkdir -p` 后原样使用;不填维持默认 `<dataDir>/agents/<id>`。
- 校验:非空、`resolve()` 归一化绝对路径;`unique` 约束防两 agent 撞同一目录,冲突报明确错。
- 下游消费 workspace 的代码(identity store 的 SOUL/USER/memory、memory 端点)**改用 `agent.workspacePath`**,删除 `<dataDir>/agents/<id>` 硬编码——否则配置化后必坏。

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

**3. Workspace bridge(抽象为一个 feature)**
- **源(单点真理,在 `dataDir` 下)**:skill `<dataDir>/skill-packs/<packId>`;knowledge `<dataDir>/knowledge/<packId>`;mcp servers 为 DB 记录(现有 mcp feature)。
- **桥接(按 agent 分配开关)**:资源经软链/写文件落到 agent workspace:
  - skill → `<workspace>/.<kind>/skills/<packId>`(软链整个 pack 目录)
  - knowledge → `<workspace>/knowledge/<packId>`(软链)
  - mcp → `<workspace>/.<kind>/mcp.json`(写入配置)
- **幂等 reconcile**:增补缺失、清理 stale 软链;触发点为 agent 创建/更新(kind/workspace 变更)、pack install/sync/assign、mcp server 增改/分配。

**4. 自研 coding_agent 布局统一,机制不改**
- 也建 `.agent/skills/`;但 child 仍走现有 `run.skillRoots` 传参(progressive-skill 插件),本次不改 child 契约。

**5. 去掉 loop-agent**
- 只 seed `default`(Assistant);loop generator/evaluator 的 member `agentId` 从 `"loop-agent"` 改为 `"default"`(loop 的 model/workspace 来自 LOOP.md 显式配置,不依赖 agent 行身份)。

## 后果

- 新 feature:`features/agent/workspace-bridge.ts`(或独立 `workspace-bridge` feature)——skill/knowledge/mcp 三类资源的桥接与 reconcile。
- seed 从"仅 SOUL/USER"扩展为完整布局;materializeWorkspace 幂等 seed。
- `loop-agent` 行不再创建;loop 相关 4 处 `"loop-agent"` 引用改 `"default"`。
- 迁移:无需新迁移(`workspacePath` 列已有);后续 knowledge 若需独立 store,再加表。
- CONTEXT.md glossary 需补 **Workspace Bridge** / **Agent Workspace** 词条(实施时同步)。

## 关联

- [ADR 0002: CLI Session 双轨真理](./0002-cli-session-dual-truth.md)
- [Gate 0 协议核实](../architecture/execution/backend-kinds-gate0.md)
- [设计哲学](../architecture/design-philosophy.md) — 单点真理 + 显式边界(资源一份,桥接分发)
