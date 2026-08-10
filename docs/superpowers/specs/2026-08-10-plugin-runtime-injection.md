# Spec: Plugin Runtime Injection（pi 风格，无 jiti）

## Problem

当前 Plugin 是纯静态对象（`{ name, hooks?, tools?, meta? }`），hooks 只能访问传入参数，无法调用模型、读写 store、访问 workspace。Pet/Recap 需要"在 hook 里调模型"和"追踪跨轮状态"，现有架构无法支撑。

## Goal

给 Plugin 注入一个 **Runtime context**（`PluginRuntime`），让 hooks 能访问 Coding Agent 的能力（模型流、store、workspace、emit），**不引入 jiti、不改 Plugin 为 class**。

## Design

### 核心思路

Pi 的 `ExtensionAPI` 是一个运行时注入的上下文对象，extension factory 接收 `pi: ExtensionAPI`，通过 `pi.on(event, handler)` 订阅事件、`pi.exec()` 执行命令、`pi.registerTool()` 注册工具。

我们的架构更简单：Plugin **已经是对象**，不需要 factory + jiti 加载。只需给 hooks **多传一个 runtime 参数**，让 plugin 在构造时捕获 runtime 引用。

### PluginRuntime 接口

```typescript
// packages/agent/src/runtime/plugin-runtime.ts

import type { AIMessageChunk } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { SessionStore } from "../persistence/session-store.js";
import type { CodingAgentLoopEvent } from "./agent-event.js";

/** Capabilities injected into plugin hooks at runtime. Mirrors a subset of
 *  pi's ExtensionContext: model stream, store, workspace, event emit. */
export interface PluginRuntime {
  /** Stream a model call (bounded by the same modelTimeoutMs as the main
   *  loop). Plugins use this for recap/pet - never for the main agent turn. */
  readonly streamModel: (
    providerId: string,
    modelId: string,
    messages: readonly Message[],
    opts?: { signal?: AbortSignal },
  ) => AsyncIterable<AIMessageChunk>;

  /** Session store (read-only for plugins): branch history, todo state. */
  readonly store: SessionStore;
  readonly sessionId: string;

  /** Run workspace root. */
  readonly workspaceRoot: string;

  /** Emit a UI-transient event to the Run SSE (never to History). */
  readonly emit: (event: CodingAgentLoopEvent) => void;

  /** The run's abort signal (for graceful shutdown). */
  readonly signal: AbortSignal;
}
```

### Hook 签名变更

```typescript
// packages/agent/src/runtime/plugin.ts

export interface PluginHooks {
  beforeModel?(messages: readonly Message[], rt: PluginRuntime): readonly Message[];
  afterModel?(messages: readonly Message[], rt: PluginRuntime): void;
  beforeStop?(cancel: () => void, rt: PluginRuntime): void;
  afterTool?(
    toolName: string,
    result: unknown,
    rt: PluginRuntime,
  ): CodingAgentLoopEvent | undefined;
}
```

每个 hook 多收一个 `rt: PluginRuntime`。**不改为 class**--plugin 仍是工厂函数返回对象，hooks 闭包捕获需要的字段。

### Agent Loop 改动

1. `CodingAgentSessionOptions` 新增 `pluginRuntime: PluginRuntime`
2. Loop 在调用每个 hook 时传入 `rt`：
   ```ts
   // beforeModel
   const result = p.hooks.beforeModel(transformed, opts.pluginRuntime);
   // afterModel (NEW hook, called after processModelTurn)
   for (const p of opts.plugins) {
     await p.hooks?.afterModel?.(messages, opts.pluginRuntime);
   }
   // afterTool
   const ev = p.hooks?.afterTool?.(call.name, result, opts.pluginRuntime);
   ```
3. `afterModel` 在 `turn_end` emit 之前调用（模型输出已持久化，工具已执行）

### Run Runtime 构建

```typescript
// apps/coding-agent/src/core/run-runtime.ts

const pluginRuntime: PluginRuntime = {
  streamModel: (providerId, modelId, messages, opts) =>
    deps.modelRuntime.stream(providerId, modelId, messages, opts),
  store,
  sessionId: deps.runId,
  workspaceRoot: deps.workspace.root,
  emit: (event) => { void session.emit(event); },
  signal: controller?.signal ?? new AbortController().signal,
};

const session = createCodingAgentSession({
  ...
  plugins,
  pluginRuntime,
});
```

### Plugin 构造模式（不变）

```typescript
// packages/plugin-recap/src/recap-plugin.ts

export function createRecapPlugin(opts: {
  recapModelRef: { providerId: string; modelId: string };
  enabled: boolean;
}): Plugin {
  let turnCount = 0;

  return {
    name: "recap",
    hooks: {
      beforeRun() { turnCount = 0; },  // optional: if added
      afterModel(messages, rt) {
        if (!opts.enabled) return;
        turnCount++;
        // rt.streamModel -> cheap model -> one-line recap
        // rt.emit -> recap_update event
      },
    },
  };
}
```

Plugin 构造时只传**配置**（modelRef, enabled），运行时能力从 hook 参数 `rt` 获取。这与 pi 的 `ExtensionFactory(pi: ExtensionAPI)` 模式一致：factory 闭包捕获配置，`pi` 提供运行时。

### 事件扩展

```typescript
// agent-event.ts 新增
| { type: "recap_update"; text: string; turn: number }
| { type: "pet_bark"; mood: string; text: string; level: number }
```

mapping.ts 的 default case 自动映射为 `backend.coding_agent.recap_update` / `backend.coding_agent.pet_bark`。Web 的 watchRun 已有事件监听模式（todo_update 同构）。

## 不做

- **不做 jiti/动态加载**：plugin 是编译期依赖，不走文件系统发现
- **不改为 class**：保持工厂函数 + 闭包，最小改动
- **不做 pi 的完整 ExtensionAPI**（exec、registerTool、registerCommand、UI、keybindings）：只做 `streamModel + store + emit + signal`，够 recap/pet 用
- **不做 plugin 热加载/reload**
- **不做 cross-session 持久化**（pet XP/等级）：MVP 纯内存

## 与 Pi 的对比

| Pi ExtensionAPI | 本方案 PluginRuntime | 理由 |
|---|---|---|
| `pi.on(event, handler)` 事件订阅 | `hooks.afterModel(messages, rt)` 直接调用 | 我们已有 hook 系统，不重做事件总线 |
| `pi.registerTool()` 动态注册 | `Plugin.tools` 静态声明 | 编译期已知，无需动态 |
| `pi.exec()` shell 执行 | 不提供（用 `bash` 工具） | plugin 不需要直接 exec |
| `pi.sendMessage()` 注入消息 | `beforeModel` 返回修改后的 messages | 已有机制 |
| `pi.registerProvider()` | 不提供 | provider 由 backend 管理 |
| `pi.streamSimple` / model access | `rt.streamModel(providerId, modelId, ...)` | 核心能力，recap/pet 必需 |
| jiti 文件加载 | 编译期 import | 无运行时加载开销 |

## Acceptance

1. `PluginRuntime` 接口定义 + `PluginHooks` 签名扩展
2. `afterModel` hook 加入 agent-loop（turn_end 之前）
3. run-runtime 构建 `pluginRuntime` 并注入 session
4. 现有 plugin（todo, progressive-skill）适配新签名（`rt` 参数加 `_` 前缀忽略）
5. `tsc -b` + 全量 test 通过
