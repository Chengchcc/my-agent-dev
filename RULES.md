# RULES.md — Agent 文件修改规则

> 跨 `AGENTS.md`、`CONTEXT.md` 共享的项目规则。每次操作文件时遵守。

## 文件修改工具选择

| 场景 | 工具 |
|---|---|
| 修改现有文件的若干行 | `edit` — 逐块手术式编辑 |
| 创建新文件或完全重写 | `write` |
| 结构化的语法级别修改 | `ast_grep` / `ast_edit` / `lsp` `rename` |

**禁止：**
- **禁止使用 `sed`，禁止使用 Python `open/write` 修改文件**。这些方法不提供 diff 预览、出错不回滚、不留审计轨迹、容易被 biome 的 `organizeImports` 或 turbo 缓存静默覆盖。
- **禁止链式 `sed` 调用**。多步编辑使用 `edit` 的多个 `SWAP`/`INS` 块，单次原子提交。
- **禁止在 bash heredoc 中写多行代码**。多行程序写入使用 `write` 工具。

**为什么：**
`sed` 和 Python 脚本修改文件时没有和 repo 的 lint/format 管道集成，产生的变更无法被 biome 正确格式化，且 subagent 在隔离文件系统上执行时可能写入不同路径或无法持久化。`edit` 和 `write` 工具与项目工作区直接集成，变更立即反映在 git 状态中。
