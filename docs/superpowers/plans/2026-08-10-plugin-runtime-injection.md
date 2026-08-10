# Plan: Plugin Runtime Injection + Recap MVP

## Wave 1: PluginRuntime 基础设施

### Task 1.1: 定义 PluginRuntime 接口
- 新文件 `packages/agent/src/runtime/plugin-runtime.ts`
- `PluginRuntime` 接口：`streamModel` / `store` / `sessionId` / `workspaceRoot` / `emit` / `signal`
- 导出 from `packages/agent/src/index.ts`

### Task 1.2: 扩展 PluginHooks 签名
- `packages/agent/src/runtime/plugin.ts`
- 每个 hook 加 `rt: PluginRuntime` 参数
- 新增 `afterModel?(messages, rt): void`
- import PluginRuntime type

### Task 1.3: Agent Loop 接入
- `packages/agent/src/runtime/agent-loop.ts`
- `CodingAgentSessionOptions` 加 `pluginRuntime: PluginRuntime`
- beforeModel: 传 `opts.pluginRuntime`
- afterModel: 在 `turn_end` emit 之前调用（processModelTurn + executeTools 之后）
- afterTool: 传 `opts.pluginRuntime`

### Task 1.4: 现有 Plugin 适配
- `packages/plugin-todo/src/todo.ts`: afterTool 加 `rt` 参数（`_rt` 忽略）
- `packages/plugin-progressive-skill/src/progressive-skill.ts`: 无 hooks，无需改
- 修复所有 test 里的 mock session（加 `pluginRuntime` stub）

### Task 1.5: Run Runtime 构建 + 注入
- `apps/coding-agent/src/core/run-runtime.ts`
- 构建 `pluginRuntime` 对象
- 传入 `createCodingAgentSession`

### Gate
- `tsc -b` 0 errors
- `bun test` 全绿（agent 68 + plugin 2 + coding-agent 69 + backend 334 + web 47）
- `bun scripts/smoke-agent-run.ts --mode clean` PASS

## Wave 2: Recap MVP

### Task 2.1: 新建 plugin-recap 包
- `packages/plugin-recap/package.json` + `tsconfig.json`
- `src/recap-plugin.ts`: createRecapPlugin({ recapModelRef, enabled })
- `afterModel` hook: 调 `rt.streamModel` 生成一句话摘要 -> `rt.emit({ type: "recap_update", text, turn })`
- `src/index.ts` barrel

### Task 2.2: 事件类型 + mapping
- `packages/agent/src/runtime/agent-event.ts`: 加 `recap_update`
- mapping.ts default case 自动覆盖（验证）

### Task 2.3: Run Runtime 接入 recap
- `apps/coding-agent/src/core/run-runtime.ts`
- 从 Run snapshot 解析 recapModelRef（或 env `CODING_AGENT_RECAP_MODEL`，默认同主模型）
- plugins 数组加 createRecapPlugin（enabled = env `CODING_AGENT_RECAP_ENABLED !== "0"`）

### Task 2.4: Web RecapPanel
- `apps/web/src/components/RecapPanel.tsx`: 常驻面板（右 260px 桌面 / 顶部条移动）
- watchRun 监听 `backend.coding_agent.recap_update` -> `runRecaps` state
- ConversationCanvas 布局：对话区 + RecapPanel 右侧
- Run terminal 时清对应 recap

### Task 2.5: 测试
- plugin-recap 单测：afterModel 调 streamModel mock + emit recap_update
- agent-loop 测试：afterModel 被调用、收到 PluginRuntime
- smoke: recap 事件经 wire 到达 SSE

### Gate
- 全量 gates + smoke

## Wave 3: Pet MVP（可选，验证 recap 后再决定）

### Task 3.1: 新建 plugin-pet 包
- 纯内存状态（mood: neutral/frustrated/happy，无 XP/等级）
- afterTool: 追踪 consecutiveErrors -> 更新 mood
- afterModel: shouldBark? -> rt.streamModel 生成 bark -> rt.emit({ type: "pet_bark" })
- bark 注入：beforeModel 把上次 bark 作为 system 消息追加

### Task 3.2: Web Pet 渲染
- watchRun 监听 `backend.coding_agent.pet_bark` -> transient bubble（同 LiveToolStep 层）
- 底部 pet 状态栏（mood + 等级 placeholder）

### Task 3.3: 测试
- plugin-pet 单测：consecutiveErrors -> frustrated -> bark
- mood 状态转移
