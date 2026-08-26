# Spec: oma 插件系统 — Claude marketplace/skills 兼容 + oma 自有 code 组件

## Problem

oma 已安装插件（`plugin-marketplace.ts`）目前只贡献 skills：manifest 纯声明式
（name/version/description/skills），`enabledPluginSkillRoots` 是插件影响 Run 的唯一
通道。

方向（2026-08-26 与用户确认，四轮收敛）：

1. **Claude 生态只要外围兼容**：marketplace 目录（`.claude-plugin/marketplace.json`）
   + skills + 插件 `.mcp.json`。不做 Claude 插件组件的完整工作（hooks.json shell
   协议、commands/、agents/、LSP 等全部不做）。
2. **代码组件走 oma 自有机制**（"oma custom tools + oma hooks"，唯一执行机制）：
   评估过兼容 omp `CustomTool` 形状 —— 差异太大（ArkType/TypeBox/zod 三栖 schema、
   `CustomToolAPI` 工厂含 exec/ui/pi-全量导出、`CustomToolContext`
   sessionManager/modelRegistry、`AgentToolResult`、renderCall/renderResult），
   适配 = 移植半个 pi 运行时，且 omp 生态工具深度绑定这些 API，放弃形状兼容。
   字段名致敬 omp（`tools`/`hooks` 入口），形状是 oma 自己的。
3. **安装 Claude 或 omp 的插件时按字段映射**：兼容字段生效（Claude 的
   skills/`.mcp.json`），不兼容的 code 字段（omp `tools`/`hooks` 入口、Claude
   `hooks.json`）检测到即忽略+警告 —— 需要 oma 形状的 code 组件时由 oma 自己的
   manifest 字段提供。冲突检查矩阵见下。

信任问题不变：project-scope 插件来自 repo，其 code 入口（in-process，比子进程更
敏感）与 `.mcp.json` stdio server 是任意代码执行；oma 还有 backend 无头 RPC 模式
（child 跑在产品基础设施上），需要比交互式 CLI 更严的门控。

## Goal

1. Manifest：oma `plugin.json` 为主（声明 oma 形状的 `tools`/`hooks` 代码入口），
   兼容读取 `.claude-plugin/plugin.json` 与 package.json `omp`/`pi` 字段并按冲突
   矩阵处理。
2. MVP 四组件：`skills`（已上线）、oma `tools` 入口（custom tools）、oma `hooks`
   入口（`PluginHooks`）、插件 `.mcp.json`（→ 现有 mcp-mount）。
3. Marketplace：目录解析兼容 `.claude-plugin/marketplace.json`（omp 同款回退）。
4. 信任边界 = 安装 scope（沿用已批准模型）：user-scope install 即同意；project-scope
   code 组件需 hash 信任记录；RPC 永拒 project-scope code 组件。

## Design

### Manifest（`plugin-marketplace.ts` 扩展）

oma `plugin.json` 增加字段（字段名对齐 omp，形状是 oma 的）：

```typescript
/** 入口模块（相对插件根），Bun 原生动态 import 加载：
 *  - tools 入口：export const tools: PluginTool[]（oma 形状）
 *  - hooks 入口：export const hooks: PluginHooks（oma 形状，现有同步签名）
 *  两者也接受 default export。 */
tools?: string;
hooks?: string;
```

多来源 manifest 读取顺序（单插件内优先级）：oma `plugin.json` →
`.claude-plugin/plugin.json`（Claude 生态插件 → skills/MCP 载体）→ package.json
`omp`/`pi` 字段（omp 生态插件 → 见冲突矩阵，code 字段不执行）。

### 冲突检查矩阵

**单插件内（manifest 字段级）**：

| 情形 | 规则 |
|---|---|
| oma `plugin.json` + `.claude-plugin/plugin.json` 并存 | oma 为准；Claude manifest 只补 oma 缺的 name/version/description/skills；警告 dual-manifest |
| package.json `omp`/`pi` 字段 + oma `plugin.json` 并存 | omp 的 `tools`/`hooks` 入口字段忽略+警告（导出形状是 omp 的，不执行）；`features`/`settings` 忽略 |
| Claude `hooks/hooks.json` 或 manifest 内联 hooks | 忽略+警告 —— hooks 只走 oma 入口 |
| Claude `commands/`、`agents/` | 忽略+警告 |

**插件间 / 与原生（组件级）**：

| 冲突 | 规则 |
|---|---|
| tool 名 vs 原生表 | native wins，跳过+警告（mcp-mount 现行策略） |
| tool 名 vs 其他插件 | 复用 `validatePlugins()` 冲突检查：后加载者跳过，顺序 = registry 顺序（deterministic） |
| 多插件 hooks 并存 | 不冲突 —— 各自 `PluginHooks` 都挂 `plugins[]`，全部触发 |
| 插件名 user/project 同名 | project shadow user（`listInstalledPlugins` 现行行为） |
| MCP server 名 | workspace `.mcp.json` > 插件；插件间 user-scope > project-scope |

### 组件适配（MVP 四件）

| 组件 | oma 映射 | 说明 |
|---|---|---|
| `skills/` | 现有 `createSkill({roots})` | 已上线，无改动 |
| oma `tools` 入口 | 动态 import + 形状校验 → 并入 Run 的 tool 表 | **oma custom tools**，见下 |
| oma `hooks` 入口 | 动态 import → `PluginHooks` 对象挂 `plugins[]` | oma 自有签名，无新协议 |
| 插件 `.mcp.json` | 现有 `mcp-mount`：多配置源合并 + `${CLAUDE_PLUGIN_ROOT}` 替换 | workspace 级同名优先 |

### oma custom tools（加载与校验）

- `loadPluginCode(root, entry)` = `await import(pathToFileURL(join(root, entry)).href)`
  —— Bun 原生 TS 转译（2026-08-26 实测验证），**无 jiti**（omp 全线也用原生 Bun
  import 加载 custom tools 和 extensions，jiti 只剩一处历史注释；它是上游 pi 的
  Node 机制）。
- tools 入口校验：导出为数组、每项有 `name`/`description`/`execute` 函数；名字
  冲突按上表矩阵处理。
- hooks 入口校验：导出为对象、键是已知 `PluginHooks` 键；未知键忽略 + 警告。
- 任何加载/校验失败 = 跳过该组件 + 警告，**绝不炸 Run**。
- 入口模块无 API 注入面（无 omp `CustomToolAPI` 等价物）：工具自足；需要
  模型/store 的场景走 `PluginHooks`（已有 `rt: PluginRuntime`）。将来不够再加
  受控注入，YAGNI。

**Tool result 契约**（吸收 omp `AgentToolResult` 的两点，其余不采纳）：

- `isError` / `terminate`：数据驱动报错与终止 —— **oma 循环已支持**
  （`agent-loop.ts` 检测 result 的 `isError`/`terminate` 字段，throw 转为
  `{error, isError}`，失败结果前置修复提醒），插件工具直接用，无需新机制。
- `content?: string`（新增，omp 的模型通道分离）：result 声明 `content` 字符串时，
  tool_result 文本**原样**用它（工具已格式化好的模型可见内容），其余字段仅供
  TUI/事件消费，不再整体 JSON dump 进模型上下文。实现 = `agent-loop.ts` 批量落账
  处 ~5 行（与现有 `images` 透传同模式：特殊字段走特殊通道）。
- 不采纳：omp `details`（UI-only 通道，成本在 TUI 通用渲染侧，MVP 用不上）、
  `AgentToolResult` 类型本身、execute 的 `ctx` 大注入面（options 对象已是可扩展
  ctx，保持薄注入）。

### Marketplace 兼容

- 目录解析：现有 marketplace manifest 优先，回退 `.claude-plugin/marketplace.json`
  （omp fetcher 同款）。Claude marketplace 的 plugin entry → source 路径 + 组件
  发现按本 spec manifest 规则与冲突矩阵。
- 安装仍走现有 cpSync + enable/disable registry（git 源、cache、版本管理不做，
  omp `source-resolver.ts` 是将来参考）。

### 信任模型（scope 即边界 — 沿用已批准设计）

关键事实：`agentDir()` = `OMA_CODING_AGENT_DIR ?? ~/.oma`，永远在 workspace 之外，
由机器所有者（本地）或部署方（RPC）控制，repo 内容无法触达。

| Scope | 规则 | 依据 |
|---|---|---|
| user（`<agentDir>/plugins`） | install 即同意；enabled 即生效（含 tools/hooks 入口与 MCP），**全模式** | install-consent；agentDir 不在攻击面内 |
| project（`<workspace>/.oma/plugins`） | **code 组件（tools/hooks 入口 + `.mcp.json` stdio server）**需信任记录：TUI 首次发现时询问一次，批准写入 `<agentDir>/trusted-plugins.json`（repo 外），新插件或 hash 变化重新询问；print/json 非交互只认已有记录，否则跳过+警告；**RPC 模式永不加载 project-scope code 组件**（不论有无记录） | repo 可被任何能 commit/push 的人植入；in-process code 比 shell hook 更敏感；RPC child 在产品基础设施上运行 |

RPC 永拒的执行位置：oma 子进程内（`resolvePluginComponents(mode: "rpc")` 自己跳
过），不依赖 backend 输入 —— 恶意构造的 Run input 无法绕过。

**不受门控**：skills 纯 markdown 组件（提示词面，沿用现状）。与 Claude 的差异：
Claude 对 project markdown 也过 trust dialog；不跟进（威胁=提示注入，非 RCE）。

hash = 插件根目录递归 sha256，排除 `node_modules`，按排序后的
`(relativePath, fileHash)` 聚合。记录文件 `<agentDir>/trusted-plugins.json`：

```json
{ "<absPluginRoot>": { "hash": "sha256:...", "trustedAt": "ISO-8601" } }
```

已知既有洞（记录在案，不在本 spec 范围）：standalone TUI 模式下 workspace 自己的
`.mcp.json` 无条件自动挂载（repo 控制的进程 spawn）。backend 模式由 workspace
bridge 写、产品控制，无此问题。将来收口。

### 接入点（策略在模式层，runtime 无策略）

```typescript
resolvePluginComponents(
  workspaceRoot: string,
  mode: "tui" | "print" | "json" | "rpc",
): { codePlugins: Array<{ root: string; toolsEntry?: string; hooksEntry?: string }>;
     mcpConfigs: McpConfig[]; warnings: string[] }
```

- TUI/print/json/RPC 四模式各自调用；加载好的 tools/hooks 与 mcp 配置传入
  `assembleRunRuntime` 新 deps，runtime 只执行挂载，不读 registry、不读信任记录。
- TUI 的"询问一次"：组装 Run 前解析，发现未信任的 project-scope code 组件或 hash
  变化时弹确认对话框（UI 层），批准即写记录；下次同 hash 不再问。
- RPC 现状核对：rpc-mode 的 skills fallback 是 `scanWorkspaceSkillRoots`，本来就不
  参与 oma 本地 plugin registry；project code 组件在 RPC 全拒，user-scope 可用。

## 失败语义

- 入口模块加载失败 / 校验失败 / 冲突矩阵判定跳过 → 跳过该组件 + 警告（TUI
  pushStatus / RPC debug log）；Run 照常。
- manifest 解析失败 / 组件文件缺失 → 同上。
- `trusted-plugins.json` 损坏 → 视为全部未信任（project-scope code 组件跳过）。

## 与 Claude / omp 的对比

| 维度 | Claude Code | omp | 本方案 |
|---|---|---|---|
| 格式 | `.claude-plugin/plugin.json` 组件目录 | package.json `omp`/`pi` 字段 + 模块入口 | oma `plugin.json` 代码入口（字段名致敬 omp）+ 兼容读 Claude/omp manifest 按冲突矩阵；无 jiti |
| 代码工具 | 无（hooks/MCP/LSP 子进程） | `CustomTool`（ArkType 三栖 + API 工厂 + 渲染） | **oma `PluginTool`**（JSON Schema + 静态对象），不做 omp 形状兼容 |
| hooks | hooks.json shell 协议（stdin/stdout JSON、exit code） | 自有 hook 模块（in-process） | oma `PluginHooks`（现有签名，in-process） |
| 安装外来插件 | — | Claude marketplace 目录 + skills 发现（外围） | Claude/omp 插件均可装：兼容字段生效，code 字段忽略+警告 |
| project 信任 | workspace trust dialog + 代码组件更严 | 无 per-directory gate（自认缺口） | project code 组件 hash 记录 + RPC 永拒 |
| markdown 门控 | project markdown 也过 trust | 无条件 | 不门控 markdown（现状；威胁=提示注入，非 RCE） |

## 不做

- **Claude hooks.json 协议**（stdin/stdout JSON、matcher、exit code 语义）——hooks
  走 oma 自有 `PluginHooks`，无子进程 hook，**`PluginHooks` 异步化也不需要**。
- **omp `CustomTool` / hook 模块形状兼容**（评估结论：移植半个 pi 运行时，放弃；
  装入的 omp 插件其 code 字段忽略+警告）。
- **jiti**（全程未引入；Bun 原生动态 import）。
- Claude 组件 `commands/`、`agents/`、LSP、monitors、themes、output-styles、
  workflows、`bin/`、frontmatter hooks。
- 插件代码 API 注入面（omp `CustomToolAPI`/`CustomToolContext` 等价物）。
- marketplace git/registry 源、cache、版本管理、依赖图（omp `source-resolver.ts`
  是将来参考）；npm 依赖自动安装。
- `userConfig`/`pluginConfigs` 机制。

## Acceptance

1. manifest 多来源读取（oma 优先 → Claude 回退 → omp 字段）+ 冲突矩阵测试：
   dual-manifest、omp code 字段忽略+警告、Claude hooks.json 忽略+警告。
2. oma custom tools：tools 入口加载 + 形状校验（合法数组 / 非法导出 / name 冲突
   native-wins / 插件间冲突后装跳过）、hooks 入口加载 + 未知键忽略、加载失败不炸
   Run 测试。
3. tool result 契约：`isError`/`terminate`/`content` 字段端到端 —— content 原样进
   tool_result 文本（不 JSON dump），isError 落 `is_error` + 修复提醒，terminate
   停 loop。
4. 端到端：enabled 插件的 tool 出现在 Run 的 tool 表（meta 可见），hook 在
   beforeTool/afterTool 触发。
5. 插件 `.mcp.json` → mcp-mount 挂载，多源合并 + workspace 同名优先 +
   `${CLAUDE_PLUGIN_ROOT}` 替换测试。
6. marketplace 目录 `.claude-plugin/marketplace.json` 回退解析测试。
7. 信任矩阵：scope × mode（user 全过；project：tui 询问 / hash 变化重问、
   print/json 只认记录、rpc 全拒；markdown/skills 组件不受门控）测试。
8. gates：typecheck / lint / `bun test`（apps/oh-my-agent）全绿。
