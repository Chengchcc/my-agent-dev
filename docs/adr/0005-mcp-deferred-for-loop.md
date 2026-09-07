# Deferred: MCP server 用于 Loop agent 运行时查询

> ⚠ **状态更新(2026-08-13)**：MCP 已落地(ADR 0012 + workspace 桥接 + product-tools MCP)，但 Loop 至今未接入 MCP。原"等 MCP 支持后执行"的前提已消失，deferral 成为长期事实：维持 Loop 不用 MCP。

## 状态

Deferred(维持；was 等 MCP 支持)

## 上下文

参考 repo（`/root/loop-engineering/tools/mcp-server`）把 STATE.md、budget、skills、patterns 暴露成 MCP resource + tool。Discovery/Evaluator agent 可以通过 `loop_get_state`、`loop_get_skill`、`loop_estimate_cost` 按需查询，不全塞 system prompt。

当前项目没有 MCP 基础设施（无 MCP server、无 MCP client transport、AgentSession 不挂 MCP tools）。M3 接线时先用字符串拼接 prompt（方案 A），待项目引入 MCP 后再切。

## 决策

**延迟至项目支持 MCP 后**，把以下 Loop 资源暴露为 MCP tools：

- `loop://state/{file}` → `loop_get_state` — 读 STATE.md（discovery/evaluator 用）
- `loop://skills/{name}` → `loop_get_skill` — 按需加载 SKILL.md（替代全量 prompt 注入）
- `loop://budget` → `loop_get_budget` — 读 loop-budget.md（预算守卫用）
- `loop://run-log` → `loop_get_run_log` — 读 run-log（预算守卫用）
- `loop://patterns/{id}` → `loop_get_pattern` — 读 pattern（loop-config-generator 用）
- `loop://registry` → `loop_list_patterns` — 列出所有 pattern（loop-config-generator 用）

## 后果

- M3 prompt 用字符串拼接（当前设计），切换 MCP 后 prompt 结构不需要改，只把"内联内容"换成"tool call 结果"
- loop-budget Skill 同样：先读文件内联，后切 MCP tool
- MCP server 实现时再写 ADR

## 关联

- [M1 loopReducer spec](../superpowers/specs/2026-07-01-m1-loop-reducer.md)
