---
id: plugins.oma-plugins
title: Oma 插件与 HITL
status: current
owners: architecture
summary: "oma 插件系统（core/plugins/）：多源 manifest（oma plugin.json → .claude-plugin/plugin.json → package.json omp/pi 字段）+ 冲突矩阵；代码组件经 Bun 原生 import 加载（PluginTool[]/PluginHooks 形状校验）；信任矩阵 = 目录 sha256 + agentDir/trusted-plugins.json + scope×mode 矩阵（RPC 永不加载 project-scope 代码）；marketplace 多源 catalog（git 源记录 HEAD rev）。HITL 审批链 = permissionMode（ask/deny/auto）门控 + approval_request → resolve_approval + 超时 fail-closed。"
depends_on:
  - runtime.oma
  - agents.workspace-and-backends
used_by:
  - architecture.workflow
---

# Oma 插件与 HITL

## 插件系统（`core/plugins/`）

### 多源 manifest 与冲突矩阵

安装一个插件，resolve 按优先级读 manifest：

```text
oma plugin.json  >  .claude-plugin/plugin.json  >  package.json(omp/pi 字段)
```

- oma manifest 的 `tools`/`hooks` entry 路径胜出；claude/omp 的 code 字段被忽略并警告
- MCP 名冲突：workspace > user-scope > project-scope；tool 名冲突：native 优先、其余按注册序
- Claude 生态只做周边兼容：marketplace catalog 回退、插件 `skills/`、插件 `.mcp.json`（mcp-mount 已解析 Claude 形状）；不做 Claude hooks.json shell 协议、commands/agents/LSP

### 代码加载与信任

- 代码组件经 **Bun 原生 `import()`** 加载（无 jiti）；形状校验后进 Run 工具表（`PluginTool[]` / `PluginHooks`，同步签名）
- **信任矩阵**：目录递归 sha256（排除 node_modules）→ `<agentDir>/trusted-plugins.json` 哈希记录；损坏 = 全不信任
- **scope×mode 矩阵**：user-scope 安装即同意（全模式可用）；project-scope 代码需 TUI 一次性确认（`/plugin trust`），**RPC 模式永不加载 project-scope 代码**（backend child 内强制）
- 工具结果内容契约：string content 原样进 tool_result，否则 JSON dump

### Marketplace

多源 catalog（`.claude-plugin/marketplace.json` 回退）；git/url 源记录 HEAD rev 为 `MarketplaceRecord.version`（TUI `/marketplace` 列表显示前 12 位）；本地目录无 version；install 用 cpSync。git/zip 物化走公共基座 `@chengchenccc/source-fetch`。

## Workspace MCP 门控

- workspace `.mcp.json` 默认不信任：TUI/print/json 需要 `/mcp trust`（文件绝对路径哈希进 trusted-plugins.json）后才会挂载；RPC 不传该 gate（产品信任）
- 未信任文件 fail-closed：不挂载任何 workspace server
- MCP 挂载多源合并（workspace 同名优先）+ `${CLAUDE_PLUGIN_ROOT}` 替换

## HITL 审批链

```text
permissionMode = ask 的工具调用
→ child 发 approval_request 事件 {callId, toolName, reason, input}
→ adapter 透传（backend.oma.* 默认映射）→ backend SSE → Web Allow/Deny 卡片
→ POST /api/agent-runs/:runId/approval {callId, decision}
→ adapter resolve_approval（id 匹配）→ child 继续/中止
```

- permissionMode 是 request 的默认应答策略：auto=分类器审查、deny=deny、ask=审批；只读工具（read/glob/grep 等）永不门控
- auto 分类器（CC auto-mode 对齐，`core/runtime/permission-classifier.ts`）
  - 审查范围：bash/eval/mcp__*/插件工具每次调用过一次分类器模型（allow 放行 / block deny / 任何故障 fail-closed）；write/edit 跳过（workspace 路径沙箱已约束，对应 CC 工作区编辑免审）
  - 输入契约：分类器输入=最近用户消息+待执行动作，**永不包含 tool results**（防注入），用户消息中的禁令（"别 push"）对分类器有约束力
  - 升级与去重：block 先升级人工一次（同一动作只发一张卡，复用 ask 审批链，超时 fail-closed deny），重复同动作静默 deny
  - 硬熔断：`rm -rf` 指向根/顶层目录/home/裸变量 glob 时熔断（分类器之前、任何审批不可覆盖）
  - 模型与超时：模型经 `OMA_PERMISSION_CLASSIFIER_MODEL`（或 `.oma/settings.json` 的 `permissionClassifierModel`）固定，缺省用 Run 模型；`OMA_CLASSIFIER_TIMEOUT_MS`（默认 30s）封顶
- 超时（`OMA_APPROVAL_TIMEOUT_MS`，默认 120s）= deny（fail-closed）；无 handler 的 mode = denyAllApprovals
- gate 覆盖 workflow 子代理：主会话与每个 subagent session 共享同一策略与升级去重集（同 Run 内同动作一张卡），子代理的判定参照=其任务 prompt + 主对话用户消息（`workflow-executor` 的 `makePermissionGate`）

## `--tools` 过滤

CLI `--tools`（`tool-filter.ts`）在最终工具表（native + MCP + plugin 汇总后、createOmaSession 前）统一过滤：纯名字 = 白名单 ONLY，`!name` 前缀 = 黑名单。模型永远看不到被滤掉的工具。

## 不变量

1. 插件代码走 native import，永不抛（形状非法 = 跳过并警告）
2. project-scope 代码永不进 RPC；信任记录损坏 = 全不信任（fail-closed）
3. HITL 超时 = deny；插件 block 优先于审批 gate
4. 注入优先：MCP 挂载的 todo_write 存在时 native todo 让位
5. backend 对 oma 透明：不干预插件挂载机制，工具事件统一 native_tool_started/completed

## 关联页面

- [Oma Runtime](../runtime/oma.md)
- [Agent 工作区与多后端](../agents/workspace-and-backends.md)
- [Agentic Workflow](../workflow.md)
- [ADR 0020（workspace 桥接）](../../adr/0020-agent-workspace-and-resource-bridge.md)
- [ADR 0026（威胁模型）](../../adr/0026-agent-threat-model.md)
