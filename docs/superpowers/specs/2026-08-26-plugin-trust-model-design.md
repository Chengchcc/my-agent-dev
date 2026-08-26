# Spec: oma 插件适配 Claude plugin 生态 — 信任模型、组件与 Hook 对齐

## Problem

oma 已安装插件（`plugin-marketplace.ts`）目前只贡献 skills：manifest 纯声明式
（name/version/description/skills），`enabledPluginSkillRoots` 是插件影响 Run 的唯一
通道。

方向（2026-08-26 与用户确认，三轮收敛）：

1. **插件格式适配 Claude Code plugin 生态** —— Claude marketplace 生态里已有的插件
   可以直接在 oma 安装运行，不自造 oma 私有格式。
2. Claude plugin 是**纯声明式组件目录，没有 in-process Plugin 对象**：manifest
   （`.claude-plugin/plugin.json`，仅 `name` 必填）+ `skills/`、`commands/`、
   `agents/`、`hooks/hooks.json`、`.mcp.json` 等目录；未识别字段刻意忽略。全部代码
   执行都是子进程（hooks shell 命令 / MCP server / LSP）。因此前一版 spec 的
   `entry` 字段（动态 import 导出 Plugin 的模块）**废弃**，jiti / 动态 import 之争
   连带消失。
3. MVP 四组件：skills、commands、hooks（仅 `command` 类型）、`.mcp.json`。

信任问题不变且更关键：project-scope 插件来自 repo（任何能 commit/push 的人可植
入），其 hooks / `.mcp.json` 就是任意代码执行；oma 还有 backend 无头 RPC 模式
（child 跑在产品基础设施上），比 Claude Code 的交互式场景更需要门控。Claude 官方
对 project-scope 的处理与我们已批准的模型同构：workspace trust dialog + 代码组件
（MCP/LSP/monitors）进一步收紧；`pluginConfigs` 明确不读 project settings；npm 依赖
安装 `--ignore-scripts` + frozen lockfile + 60s 超时。Claude 文档同样明言："Command
hooks execute shell commands with your full user permissions"。

## Goal

1. 插件格式 = Claude plugin 格式（`.claude-plugin/plugin.json` + 组件目录约定）；
   oma 旧 `plugin.json` 作为别名保留。
2. MVP 四组件：`skills`、`commands`、`hooks`（仅 `command` 类型）、`.mcp.json`。
3. Hook 行为**对齐 Claude hooks reference 的定义**（配置 schema、matcher、执行
   形式、stdin/stdout 协议、exit code 语义、决策字段），映射到 oma 现有
   `PluginHooks`。唯一的契约扩展见下（hook 返回值放宽为可 Promise）。
4. 信任边界 = 安装 scope（沿用已批准模型）：user-scope install 即同意；project-scope
   代码组件需 hash 信任记录；RPC 永拒 project-scope 代码组件。

## Design

### Manifest（`plugin-marketplace.ts` 扩展）

- 读取顺序：`.claude-plugin/plugin.json` 优先，回退 oma 旧 `plugin.json`（现有
  skills-only 插件继续工作）。
- 只消费 Claude schema 子集：`name`（必填）、`version`、`description`、`skills`、
  `commands`、`agents`（解析但 MVP 不启用）、`hooks`、`mcpServers`；未识别字段忽略
  （与 Claude 行为一致）。
- 路径规则照 Claude：`skills/` 始终扫描且 manifest `skills` 字段是**追加**；
  `commands`/`hooks`/`mcpServers` 字段存在则**替换**默认目录。

### 组件适配（MVP 四件）

| Claude 组件 | oma 映射 | 说明 |
|---|---|---|
| `skills/` | 现有 `createSkill({roots})` | 已上线，无改动 |
| `commands/*.md` | 并入 skill 索引 + TUI 斜杠命令别名 `/<name>` | flat markdown 本质是 skill 的扁平形式（Claude 官方定位） |
| `hooks/hooks.json` 或 manifest 内联 | 编译期 wrapper Plugin（新 `claude-hooks.ts`），见下两节 | `type:"command"` 用 `Bun.spawn` 执行 |
| `.mcp.json` | 现有 `mcp-mount` 挂载 | `${CLAUDE_PLUGIN_ROOT}` 路径替换 |

## Hook 对齐（核心节，依据官方 hooks reference）

### 配置 schema（照抄）

```jsonc
{
  "hooks": {
    "PreToolUse": [           // 事件 → matcher group 数组
      {
        "matcher": "Bash",    // 可选；过滤规则见下
        "hooks": [            // handler 数组，匹配则全部执行（并行）
          { "type": "command", "command": "node", "args": ["..."], "timeout": 60 }
        ]
      }
    ]
  }
}
```

三层：事件 → matcher group → handler。顶层可带 `description`（忽略）。

**matcher 语义**（对齐）：值只含字母/数字/`_`/`-`/空格/`,`/`|` → 精确匹配（`|`/`,`
分隔列表）；含任何其他字符 → JS 正则、**不锚定**（`RegExp.test`）；`"*"`/空/省略 =
匹配全部。tool 事件的 matcher 作用于 `tool_name`（MCP 工具名形如
`mcp__<server>__<tool>`）。

### Handler 执行形式（对齐）

- **exec form**：`args` 存在 → `command` 解析为可执行文件直接 spawn（`Bun.spawn`
  数组参数），无 shell，占位符按纯字符串替换。
- **shell form**：`args` 缺省 → `sh -c <command>`。
- 路径占位符 `${CLAUDE_PLUGIN_ROOT}`（插件根）、`${CLAUDE_PROJECT_DIR}`（=
  workspace root）替换进 `command`/`args`，并导出为同名环境变量。
- **timeout**：handler 级 `timeout`（秒），默认 **600**（对齐 Claude）。超时 = 杀
  进程 + 警告 + **无决策、放行**（fail-open；Claude 明文：PreToolUse 超时不阻断）。
- 同一 group 内全部匹配 handler 并行执行；`if` 字段 MVP 忽略 + 警告（Claude 自己也
  标注 best-effort、fail-open，建议用 permission 而非 hook 做硬门）。
- 输出字符串 10,000 字符截断（对齐）。

### stdin 输入协议（对齐）

每个事件向 handler stdin 传 JSON。公共字段：

| 字段 | oma 取值 |
|---|---|
| `session_id` | Run 的 runId |
| `transcript_path` | oma session 文件路径（TUI/print 有；无则省略） |
| `cwd` | workspace root |
| `permission_mode` | Run 冻结的 permissionMode（`ask`/`auto`/`deny`，transport 已有） |
| `hook_event_name` | 事件名 |

tool 事件附加：`tool_name`、`tool_input`、`tool_use_id`；PostToolUse 另加
`tool_response`、`duration_ms`。文件工具的 `tool_input.file_path` 规范为绝对路径
（oma 工具本就如此）。

### stdout / exit code 协议（对齐）

- stdout 首个非空白字符为 `{` → 按 JSON 解析；否则纯文本。
- **exit 0**：静默（无决策，放行）或 JSON 决策。
- **exit 2**：硬阻断（任何 JSON 不能覆盖）。
- **其他 exit**：非阻塞错误 —— 动作放行 + 警告（Claude 明文：exit 1 不阻断）。
- 通用 JSON 字段：`continue`/`stopReason`（MVP 忽略+警告）、`systemMessage`（→ TUI
  pushStatus / RPC debug log）、`terminalSequence`（忽略）。
- 启动失败（路径不存在等，exit 127 类）同"其他 exit"处理。

### 事件映射与决策字段（MVP 四事件）

| Claude 事件 | oma PluginHooks | 决策字段处理 |
|---|---|---|
| `SessionStart` | `beforeRun` | 不能 block（对齐 Claude）。纯文本 stdout 或 `hookSpecificOutput.additionalContext` → wrapper 记录，经 `beforeModel` 追加一条 system-reminder 形式的 user 消息注入上下文。`sessionTitle`/`watchPaths`/`reloadSkills`/`initialUserMessage`/`CLAUDE_ENV_FILE` 忽略。`source` 恒 `"startup"`（oma Run 即会话单位；有 sessionTranscript 时 `"resume"`）。matcher 作用于 source。 |
| `PreToolUse` | `beforeTool` + `transformToolArgs` | `permissionDecision:"deny"` 或 exit 2 → `beforeTool` 返回 `{block:true, reason: permissionDecisionReason \|\| stderr}`；`"allow"` = 无操作（oma 无权限弹窗，语义兼容）；`"ask"`/`"defer"` 忽略+警告。`updatedInput` → `transformToolArgs` 返回重写后的 input。`additionalContext` 忽略（oma 无 tool-result 级注入面）。多 hook 决策优先级 deny > defer > ask > allow（MVP 即 deny 胜）。 |
| `PostToolUse` | `afterTool` | 不能 undo（工具已执行，对齐）。`decision:"block"` + `reason` → 工具结果后附加 reason 反馈；`updatedToolOutput` → `afterTool` 返回 `{content: 替换值}`（oma 的 content 覆盖即 Claude 的 updatedToolOutput）；exit 2 → stderr 作为附加反馈。`additionalContext`/`classifierContext` 忽略。 |
| `Stop` | `beforeStop` | `decision:"block"` + `reason` 或 exit 2 → 调 `cancel()` veto 强制续跑（oma 现有机制），`reason`/stderr 作为下一轮指令注入；输入带 `stop_hook_active`（oma 已在 veto 循环内，语义一致）；连续 veto 上限 = `maxForceContinues`（现值 4；Claude 为 8，保持 oma 现值不改）。`hookSpecificOutput.additionalContext` → 注入反馈消息。输入含 `last_assistant_message`。 |


### PluginHooks 契约扩展（唯一必要改动）

oma 的 `beforeTool`/`afterTool`/`transformToolArgs`/`beforeStop`/`beforeModel` 目前
是**同步签名**（同步返回判定值），而 command hook 是子进程异步 I/O —— wrapper 必须
await 进程退出才能拿到决策。同步 `Bun.spawnSync` 会阻塞事件循环最长 600s（默认
超时），并行工具批与 TUI 渲染都不可接受，不采用。

因此：上述五个 hook 的返回类型放宽为 `T | Promise<T>`，`agent-loop.ts` 调用点
`await`（循环本身全异步，天然安全；`afterRun` 已是 `void | Promise<void>` 的先例，
plugin 异常的 try/catch 语义不变）。现有同步 plugin 零改动。这是本 spec 对
runtime 的唯一侵入性改动。

### 明确不对齐的部分（MVP 非目标）

- handler 类型 `http`/`mcp_tool`/`prompt`/`agent`（忽略 + 警告）。
- `if` 字段（权限规则语法）、`async`/`asyncRewake`。
- `UserPromptSubmit` 及其余全部事件（`SessionEnd`/`PreCompact`/`Notification`/...）。
- `CLAUDE_ENV_FILE`、`terminalSequence`、`watchPaths`、`sessionTitle`、
  `initialUserMessage`、`reloadSkills`、`classifierContext`、`continue:false`。
- skills/agents frontmatter 内嵌 hooks（Claude 支持，我们只读插件的
  `hooks/hooks.json`）。
- Windows `shell: "powershell"`。

## 信任模型（scope 即边界 — 沿用已批准设计；门控对象 = hooks 与 MCP）

关键事实：`agentDir()` = `OMA_CODING_AGENT_DIR ?? ~/.oma`，永远在 workspace 之外，
由机器所有者（本地）或部署方（RPC）控制，repo 内容无法触达。

| Scope | 规则 | 依据 |
|---|---|---|
| user（`<agentDir>/plugins`） | install 即同意；enabled 即生效（含 hooks 与 MCP），**全模式** | Claude/omp 同款 install-consent；agentDir 不在攻击面内 |
| project（`<workspace>/.oma/plugins`） | 代码组件（`type:"command"` hooks + `.mcp.json` stdio server）需信任记录：TUI 首次发现时询问一次，批准写入 `<agentDir>/trusted-plugins.json`（repo 外），新插件或 hash 变化重新询问；print/json 非交互只认已有记录，否则跳过+警告；**RPC 模式永不加载 project-scope 代码组件**（不论有无记录） | repo 可被任何能 commit/push 的人植入；RPC child 在产品基础设施上运行。Claude 同构：project hooks 要过 workspace trust，`-p` 无头模式除外——我们的 RPC 比其 `-p` 更不可信，故一刀切永拒 |

RPC 永拒的执行位置：oma 子进程内（`resolvePluginComponents(mode: "rpc")` 自己跳
过），不依赖 backend 输入 —— 恶意构造的 Run input 无法绕过。

**不受门控**：skills / commands / agents 纯 markdown 组件（提示词面，沿用现状 ——
`.oma/skills` 本就无条件加载）。与 Claude 的差异：Claude 对 project markdown 也过
trust dialog；我们不跟进（威胁=提示注入，非 RCE，且现状如此）。

hash = 插件根目录递归 sha256，排除 `node_modules`，按排序后的
`(relativePath, fileHash)` 聚合。记录文件 `<agentDir>/trusted-plugins.json`：

```json
{ "<absPluginRoot>": { "hash": "sha256:...", "trustedAt": "ISO-8601" } }
```

## 接入点（策略在模式层，runtime 无策略）

```typescript
resolvePluginComponents(
  workspaceRoot: string,
  mode: "tui" | "print" | "json" | "rpc",
): { approvedHooks: HookConfig[]; approvedMcp: McpConfig[]; warnings: string[] }
```

- TUI/print/json/RPC 四模式各自调用；hooks wrapper Plugin 与 mcp-mount 配置传入
  `assembleRunRuntime` 新 deps，runtime 只执行挂载，不读 registry、不读信任记录。
- TUI 的"询问一次"：组装 Run 前解析，发现未信任的 project-scope 代码组件或 hash
  变化时弹确认对话框（UI 层），批准即写记录；下次同 hash 不再问。
- RPC 现状核对：rpc-mode 的 skills fallback 是 `scanWorkspaceSkillRoots`，本来就不
  参与 oma 本地 plugin registry；project 代码组件在 RPC 全拒，user-scope hooks/MCP
  可用（agentDir 由部署方控制）。

## 失败语义

- handler 失败/超时：按上文 exit code 协议 —— 不炸 Run（fail-open），警告记录在
  TUI pushStatus / RPC debug log。
- manifest 解析失败 / 组件文件缺失 → 跳过该组件 + 警告；Run 照常。
- `trusted-plugins.json` 损坏 → 视为全部未信任（project-scope 代码组件跳过）。

## 与 Claude / omp 的对比

| 维度 | Claude Code | omp | 本方案 |
|---|---|---|---|
| 格式 | `.claude-plugin/plugin.json` 组件目录 | package.json `omp`/`pi` 字段 + jiti 模块 | **采纳 Claude 格式**；无 jiti、无动态 import |
| hooks | 5 类 handler、30 事件、stdin/stdout JSON 协议 | extensions 进程内 jiti API | `command` 类型 + 4 事件，协议逐字段对齐，映射到编译期 wrapper |
| 代码执行 | hooks/MCP/LSP 子进程 | extensions 进程内 jiti | hooks/MCP 子进程（同 Claude） |
| project 信任 | workspace trust dialog；代码组件更严；pluginConfigs 不读 project | 无 per-directory gate（自认缺口） | project 代码组件 hash 记录 + RPC 永拒 |
| markdown 门控 | project markdown 也过 trust dialog | 无条件 | 不门控 markdown（现状；威胁=提示注入，非 RCE） |
| 依赖安装 | npm deps `--ignore-scripts` 自动装 | bun install | 不自动装 |

## 不做

- **`entry` / in-process 模块加载**（前一版设计，随 Claude 格式采纳而废弃）。
- **jiti**（全程未引入）。
- hook 类型 `http`/`mcp_tool`/`prompt`/`agent`；MVP 四事件之外的全部事件。
- `if` 字段、async hooks、CLAUDE_ENV_FILE、terminalSequence 等上文列出的字段。
- `agents/`、LSP、monitors、themes、output-styles、workflows、`bin/`（下期按需评估）。
- npm 依赖自动安装（Claude 的 `--ignore-scripts` 机制）—— 插件自带依赖或用
  SessionStart hook 自装。
- `userConfig`/`pluginConfigs` 机制。
- marketplace cache / 版本管理 / 依赖图 parity（沿用现有 cpSync 安装 + enable/disable）。

## Acceptance

1. manifest 双读（`.claude-plugin/plugin.json` 优先、旧 `plugin.json` 回退）+
   Claude schema 子集解析、未识别字段忽略、路径替换/追加规则测试。
2. `commands/` → TUI 斜杠命令端到端（`/name` 可见并可触发）。
3. hooks wrapper 对齐测试：
   - matcher（精确/列表/不锚定正则/省略全匹配）；
   - exec form 与 shell form、`${CLAUDE_PLUGIN_ROOT}` 替换 + 环境变量导出；
   - exit 0 静默 / exit 2 硬阻断 / 其他 exit 放行+警告；
   - stdout JSON 解析（`{` 开头）与纯文本回退；
   - PreToolUse：deny → `{block, reason}`；updatedInput → transformToolArgs 重写；
   - PostToolUse：decision block+reason 附加反馈；updatedToolOutput → content 覆盖；
   - Stop：block → cancel() veto + reason 注入，连续 veto 受 maxForceContinues 约束；
   - SessionStart：additionalContext 注入 beforeModel；
   - timeout fail-open（PreToolUse 超时不阻断）；
   - PluginHooks 异步化：同步 plugin 行为不变，异步（子进程）wrapper 决策生效。
   - 未知事件/handler 类型/不支持字段忽略+警告。
4. `.mcp.json` → mcp-mount 挂载，`${CLAUDE_PLUGIN_ROOT}` 替换测试。
5. 信任矩阵：scope × mode（user 全过；project：tui 询问 / hash 变化重问、print/json
   只认记录、rpc 全拒；markdown 组件不受门控）测试。
6. gates：typecheck / lint / `bun test`（apps/oh-my-agent）全绿。
