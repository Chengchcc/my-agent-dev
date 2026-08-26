# Spec: oma code-backed plugins — 信任模型与加载（无 jiti）

## Problem

已安装插件（`plugin-marketplace.ts`）目前只贡献 skills：`PluginManifest` 是纯声明式
（name/version/description/skills/commands-reserved），`enabledPluginSkillRoots` 是插件
影响 Run 的唯一通道。hooks/tools 无法由已安装插件提供 —— 这是 code-backed plugin 相对
MCP（工具）与 skills（提示词）的唯一不可替代增量。

`docs/future-work.md` 原计划用 jiti 做运行时加载。已修正（2026-08-26）：本 repo 是
Bun-only，`await import("x.ts")` 原生转译加载 TS（已实测，named/default export 均可），
jiti 是 Node 兼容 shim，不引入。

真正的设计难点不是加载器，是信任模型。部署差异决定了不能照抄 omp：

- omp 是用户自己机器上的交互式 CLI，repo 是用户自己 clone 的。
- oma 除了 TUI/print/json 还有 **backend 无头 RPC 模式**：child 进程跑在产品基础设施
  上，workspace 来自外部输入。恶意 repo 带一个 `.oma/plugins/x/plugin.json + entry`
  就是产品侧 RCE。
- omp 源码自认没有 per-directory trust gate：`.omp/extensions`、`.omp/config.yml` 等
  project-local 输入无条件加载（omp `extensions/types.ts` `isProjectTrusted()` 恒
  `true`，注释明言 "OMP has no equivalent per-directory trust gate"）。pi ≥0.79 的
  ask-once 也救不了无头场景（child 无人可问）。

## Goal

1. `plugin.json` 可声明代码入口（`entry`），已安装插件可向 Run 贡献
   `Plugin`（hooks/tools/meta）。
2. 信任边界 = 安装 scope；威胁模型 = 防恶意 repo（project-scope 代码默认拒绝）。
3. 不引入 jiti、不新增插件 API 面（能力 = 现有 `PluginHooks` + `PluginRuntime`）。

## Design

### Manifest 扩展（`plugin-marketplace.ts`）

```typescript
/** Code entry: a module default-exporting a Plugin or a factory
 *  (ctx: { workspaceRoot }) => Plugin. Relative to the plugin root. */
entry?: string;
```

单一 `entry`，而非 omp 的 tools/hooks/commands/extensions 四目录扫描：我们的
`Plugin` 对象本就是这些能力的载体，一个入口导出一个 Plugin 是最小形状。

### 加载器（新 `core/plugins/plugin-loader.ts`）

- `loadPluginModule(root, entry)` = `await import(pathToFileURL(join(root, entry)).href)`。
- 校验链，任何一步失败 = 跳过该插件并警告，**绝不炸 Run**：
  1. default export 是对象，或以 `{ workspaceRoot }` 上下文调用的工厂其结果是对象
     （工厂可忽略参数）；
  2. 结果的 `name` 必须等于 manifest `name`（防身份混淆/影子攻击）；
  3. 复用 `validatePlugins()` 做 name/tool 冲突检查后合并进 Run 的 `plugins[]`。
- 能力面 = 现有 `PluginHooks`（含 `rt: PluginRuntime` 参数），不新增 exec /
  registerTool / registerCommand / timers 等 omp ExtensionAPI 面。

### 信任模型（scope 即边界）

关键事实：`agentDir()` = `OMA_CODING_AGENT_DIR ?? ~/.oma`，永远在 workspace 之外，
由机器所有者（本地）或部署方（RPC）控制，repo 内容无法触达。

| Scope | 规则 | 依据 |
|---|---|---|
| user（`<agentDir>/plugins`） | install 即同意；enabled 即加载（含 code entry），**全模式** | 与 omp 同款 install-consent；agentDir 不在攻击面内 |
| project（`<workspace>/.oma/plugins`） | code entry 需信任记录：TUI 首次发现时询问一次，批准写入 `<agentDir>/trusted-plugins.json`（repo 外），新 plugin 或 hash 变化都重新询问；print/json 非交互，只认已存在记录，否则跳过+警告；**RPC 模式永不加载 project-scope 代码**（不论有无记录） | repo 可被任何能 commit/push 的人植入；RPC child 在产品基础设施上运行。omp 的缺口正是 project-local 无条件加载 |

RPC 永拒的执行位置：oma 子进程内（`resolveCodePlugins(mode: "rpc")` 自己跳过），
不依赖 backend 输入 —— 恶意构造的 Run input 无法绕过。

project-scope 的 **skills 贡献不受影响**（markdown 是提示词面，现状保留）。

### hash 定义

信任记录的 hash = 插件根目录递归 sha256，排除 `node_modules`，按排序后的
`(relativePath, fileHash)` 聚合。只 hash entry 文件会漏掉插件自带辅助模块，是错
误的省事。

记录文件 `<agentDir>/trusted-plugins.json`：

```json
{ "<absPluginRoot>": { "hash": "sha256:...", "trustedAt": "ISO-8601" } }
```

### 接入点（策略在模式层，runtime 无策略）

新纯函数（`plugin-loader.ts`）：

```typescript
resolveCodePlugins(
  workspaceRoot: string,
  mode: "tui" | "print" | "json" | "rpc",
): { approved: Array<{ root: string; entry: string }>; warnings: string[] }
```

- TUI/print/json/RPC 四模式各自调用，把 `approved` 传入 `assembleRunRuntime` 新 dep
  `codePluginEntries`；runtime 只负责 import + 校验 + 合并，不读 registry、不读信任
  记录。
- TUI 的"询问一次"：组装 Run 前解析，发现未信任的 project-scope code entry 或
  hash 变化时弹确认对话框（UI 层），批准即写记录；下次同 hash 不再问。
- RPC 现状核对：rpc-mode 的 skills fallback 是 `scanWorkspaceSkillRoots`，本来就不
  参与 oma 本地 plugin registry；code plugin 在 RPC 只来自 user-scope。

### 失败语义

加载失败 / 校验失败 / 未信任 → 跳过该插件 + 状态警告（TUI pushStatus，RPC debug
log）；Run 照常。`trusted-plugins.json` 损坏 → 视为全部未信任（project-scope 跳过）。

## 与 omp 的对比（学到了什么、刻意不同在哪）

| omp | 本方案 | 理由 |
|---|---|---|
| package.json `omp`/`pi` 字段 + tools/hooks/commands/extensions 四目录 | `plugin.json` 单 `entry` | Plugin 对象即载体，最小形状 |
| install 即同意（user-scope） | 相同 | install-consent 模型成立 |
| project-local 无条件加载（自认缺口） | project-scope code 需 hash 信任记录 + RPC 永拒 | 我们有无头 RPC 部署面 |
| jiti 运行时加载 | Bun 原生动态 `import()` | Bun-only repo，jiti 无增量 |
| ExtensionContext（exec/registerTool/timers/...） | 现有 PluginHooks + PluginRuntime | ADR 0016：Plugin 是唯一扩展机制 |

## 不做

- **不引入 jiti**（本 spec 的出发点）。
- **不做 omp ExtensionAPI**（exec、registerTool、registerCommand、UI、timers）。
- **不做 markdown commands 加载**（manifest `commands` 字段保持 reserved）。
- **不做 marketplace 自动升级 / registry / cache parity**。
- **不做沙箱/进程隔离**：code plugin 本质是进程内任意代码，本 spec 解决的是
  **授权**（谁允许进进程），不是**隔离**；要隔离请走 MCP server（进程外、token 门控）。
- **不做信任记录的用户级管理 UI**（手改 JSON 即可，有需求再加 `/plugin trust` 命令）。

## Acceptance

1. `plugin-loader.ts`：加载 + 校验链（合法对象 / 工厂 / 非法导出 / name 不匹配）测试。
2. `resolveCodePlugins` scope × mode 矩阵测试（user 全模式通过；project：tui 需记录、
   print/json 只认记录、rpc 全拒；hash 变化 → 重新询问/跳过）。
3. 信任记录读写 + 损坏容错测试。
4. `assembleRunRuntime` 合并 `codePluginEntries`：端到端 —— enabled 插件的 tool 出现
   在 Run 的 tool 表（meta 可见），加载失败 Run 不失败。
5. gates：typecheck / lint / `bun test`（apps/oh-my-agent）全绿。
