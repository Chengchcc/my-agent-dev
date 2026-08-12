# ADR 0002: CLI Session 是运行态真理，Context Branch 是产品真理（双轨）

## 状态

Accepted

## 上下文

多 coding-agent backend 切换（claude / pi / omp）后，执行协议出现语义分叉：

- **coding_agent**（自家 child）：每次 Run 喂入 full Product Context projection，context tree 是唯一真理，无跨 Run session。
- **CLI backends**：claude 的 stream-json 协议只收 user 消息、pi/omp 是每 turn 短进程——合成历史喂不进结构化协议（或只能退化为纯文本，丢失工具结构）。上下文续接只能依赖 CLI 自己的 session（claude `session_id` / pi·omp 会话文件）。

Gate 0 实测（docs/architecture/execution/backend-kinds-gate0.md）：

- omp：`cp 会话文件 + omp -r <副本>` 成功续上下文（cacheRead=21120 证明历史载入）——fork 机制可行。
- claude：`--resume <sessionId>` 原生续接；`--fork-session` 在用户 fork 动作时可用（per-turn 路径禁用）。
- pi：`--session <path>` 写+续，session 文件复制即可 fork。

## 决策

**CLI session 是运行态真理，context tree 是产品真理。双轨显式共存。**

1. 分支新增 `cliSessionRef` 字段（claude session_id / pi·omp 会话文件路径），agent-context 层存取；`agent_context_branch.cli_session_ref` 可空列（迁移 0024）。
2. fork 映射：pi/omp = 复制会话文件到分支路径；claude = 用户 fork 动作时 `--fork-session`（不在 per-turn 路径，solo blocklist 同款）。
3. steer 映射分 backend：claude 下一条输入 = 新 turn 输入（per-turn 形态下与 pi/omp 同构：排队为下一 turn）；无真 mid-turn 打断。
4. 回滚/undo **语义降级，显式接受**：产品树可退，CLI session 不可退；重放 = 以最新输入重开 turn。UI 对 CLI backends 隐藏或降级 replay 入口。
5. 产品工具全量对齐：claude `--mcp-config` / omp workspace `mcp.json` / pi 经 `pi-mcp-adapter` 扩展（proxy 工具 + `.mcp.json`）；产物仍是 run 级授权（`setRunProductTools` 不变）。

## 后果

- CONTEXT.md 不变量 9 修订（"无跨 Run session/resume/daemon" → 双轨描述）。
- 新词条 **CLI Session** 入 glossary，与 **Context Branch** 区分。
- 迁移 0024：`agents.backend_kind`（默认 `coding_agent`）+ `agent_context_branch.cli_session_ref`（可空）。
- contracts 测试参数化：steer/abort 断言按 kind 放宽（CLI backends 无协议内 abort，stop = kill）。
- 既有 coding_agent 路径零变化（仍全量投影）。

## 关联

- [Gate 0 协议核实](../architecture/execution/backend-kinds-gate0.md)
- [设计哲学](../architecture/design-philosophy.md) — 双轨是协议面事实，不是设计偏好
