# M4 Spec — Framework 补齐

> M4 把 `@chengchenccc/framework` 从 M3 的可跑状态补齐到架构文档定义的形态。
> 经过 17 轮设计 review，所有模糊地带已精确化。这是**施工图**，不是设计稿。

---

## 一、定位

M4 是 `@chengchenccc/framework` 的**内部补齐**：

- 零新依赖（只依赖 `core`，fileCheckpointer 依赖 `node:fs/promises`）
- 不动 M1/M2 包
- 不进入 Harness / Backend 层（M5+）
- 不引入新概念——只把架构文档定义好的接口和实现写出来

---

## 二、设计原则

沿用 M1-M3 不变。

- **第一性原理** — Interrupt/resume 来自 human-in-the-loop 的真实需求；ContextManager 来自 context window 上限的物理事实
- **奥卡姆剃刀** — 三大内化能力（Checkpointer / ContextManager / Logger）统一样式：接口 + 默认实现 + `createAgent` 可注入替换
- **状态归调用方** — ContextManager 不改 `thread.messages`，只产出视图；Checkpointer 存完整版
- **Rule of Three** — 三大内化能力都内化，Plugin 收回成纯扩展点角色

---

## 三、17 项设计决策（Grill Session 结晶）

| Q# | 决策 |
|----|------|
| Q1 | `AgentMessage` → `AgentEvent`，envelope `{ type, payload }`；`Interrupt` 独立类型；Checkpointer 的 `AgentEvent` → `CheckpointEvent` |
| Q2 | `#runLoop()` 入口契约：messages 末尾 ∈ {user(text), user(tool_result)} 且已 save；`run`/`resume` 各负责 prep；`#executeOne` 用布尔返回值传 interrupt 信号 |
| Q3 | `fileCheckpointer({ path })` → `fileCheckpointer({ dir })` breaking change；构造时 `mkdir recursive` fail fast |
| Q4 | 原子写靠 `tmp + rename`（`node:fs/promises`），不 fsync；`consumeInterrupt` = read + unlink；`.tmp.*` 残留不主动清理 |
| Q5 | `inMemoryCheckpointer()` 默认；`AgentConfig.checkpointer` optional；`HookContext.checkpointer` 必需（非可选） |
| Q6 | ContextManager 答"哪些"（集合选择），Plugin.beforeModel 答"什么样"（元素修饰）——两层正交 |
| Q7 | `ContextManagerContext` 加 `model: ChatModel` + `logger: Logger`；summarizer 三段式（用户传 > 内置 prompt + ctx.model > 无） |
| Q8 | `ChatModel.countTokens?(messages)` 可选方法；`tokenBudgetContextManager` 三段式 fallback（用户传 > ctx.model.countTokens > 字符近似） |
| Q9 | `InterruptSignal` **仅** `tool.execute` 抛时被识别；beforeTool 阻止 tool 用 `{skip,result}`；permission 用 `withPermission(tool)` 包装器 |
| Q10 | fork 共享所有能力引用；**强制新 threadId**（同 id throw，无 id auto-uuid） |
| Q11 | threadId 白名单 `^(?!\.)[A-Za-z0-9_\-.]{1,128}$`；禁止全点；禁止以点开头 |
| Q12 | `appendEvent`/`readEvents` + `saveInterrupt`/`consumeInterrupt` 协议强制成对；`createAgent` 构造时校验 |
| Q13 | before* 抛 = 短路 + abort；after* 抛 = warn + 继续 pipeline；不引入可配置策略 |
| Q14 | `keepFirst: number`（前 N 条），不识别 system；配对感知独立兜底 |
| Q15 | 改名 `maxCharsPerResult`，按 `string.length` 截；不处理 surrogate pair 半残 |
| Q16 | systemPrompt auto-insert 保留在 createAgent；CM 看到完整 messages 自由决定 |
| Q17 | 保持每 tool save + 每 turn save 细粒度；不优化；用户可自行包装 checkpointer debounce |

---

## 四、交付范围

### 4.1 Agent 合约——AgentEvent envelope

```ts
type AgentEvent =
  | { type: 'message'; payload: Message }
  | { type: 'interrupted'; payload: Interrupt };

interface Interrupt {
  pendingTool: ToolUseBlock;
  reason: string;
  meta?: Record<string, unknown>;
}
```

- **envelope 统一**：所有 yield 都是 `{ type, payload }`。调用方用 `switch (ev.type)` 判别
- **`Interrupt` 是纯领域类型**：不含 `type` 字段。Checkpointer 的 `InterruptState` 可复用
- **命名**：`AgentEvent` = framework 流事件（对外 yield）；`CheckpointEvent` = checkpointer 持久化事件（内部审计）。不撞名

| 项 | M3 现状 | M4 目标 |
|---|---|---|
| `Agent.run()` 返回 | `AsyncIterable<Message>` | `AsyncIterable<AgentEvent>` |
| `Agent.resume()` | 无 | `resume(command: ResumeCommand): AsyncIterable<AgentEvent>` |
| `AgentEvent` | 无 | `{ type: 'message' \| 'interrupted', payload }` |
| `Interrupt` | 无 | `{ pendingTool, reason, meta? }` |
| `ResumeCommand` | 无 | `{ approved: boolean, message?: string }` |
| 并发保护 | `run()` only | `run()` + `resume()` 都受 `#running` 保护 |

**ResumeCommand 语义对齐**：
```ts
tool_result.is_error = !command.approved;
tool_result.content  = command.message ?? (command.approved ? 'approved' : 'denied by user');
```

### 4.2 `#runLoop()` 抽取

**入口契约**：调用 `#runLoop()` 前，`thread.messages` 末尾 ∈ {user(text), user(tool_result)} 且已 `checkpointer.save()`。`#runLoop` 不 push 前置消息，直接进入 shape → beforeModel → model.stream → tool → loop。

三层职责：

| 层 | 方法 | 职责 |
|----|------|------|
| prep | `run()` / `resume()` | 接收外部输入 → 翻译成 Message → push → save → 调 `#runLoop` |
| work | `#runLoop()` | shape → beforeModel → model.stream → tool_use? → delegate to `#executeOne` |
| inner step | `#executeOne(call)` | beforeTool → skip? → execute → catch InterruptSignal → push tool_result → afterTool → save；返回 `boolean`（true=interrupted） |

`#executeOne` 用**布尔返回值**传递 interrupt 信号到 `#runLoop`，而不是抛错穿透——避免 try/catch 噪音穿透到 `run`/`resume`。

**Interrupt 时 `#executeOne` 不 push tool_result**——messages 末尾停在 `assistant(tool_use)`。Resume 进来先 push tool_result 修复到合法态再进 `#runLoop`。

`#runLoop` 四种退出：
1. 正常完成（无 tool_use）→ return
2. maxSteps → return
3. Interrupted（`#executeOne` 返回 true）→ return
4. 抛错（beforeModel / CM.shape / model.stream / 非 InterruptSignal 的 tool 错误）→ 穿透到 run/resume 的 finally

### 4.3 Checkpointer 三层能力

```ts
interface Checkpointer {
  // ===== Tier 1: 必需 =====
  save(threadId: string, messages: readonly Message[]): Promise<void>;
  load(threadId: string): Promise<Message[] | null>;

  // ===== Tier 2: Interrupt（成对）=====
  saveInterrupt?(threadId: string, state: InterruptState): Promise<void>;
  consumeInterrupt?(threadId: string): Promise<InterruptState | null>;

  // ===== Tier 3: Event Stream（成对）=====
  appendEvent?(threadId: string, event: CheckpointEvent): Promise<void>;
  readEvents?(threadId: string): AsyncIterable<CheckpointEvent>;
}
```

**能力分层成对契约**：Tier 2 要么都有要么都无，Tier 3 同样。`createAgent` 构造时校验，不成对 → throw fail fast。

配套类型：

```ts
class InterruptSignal extends Error {
  constructor(reason: string, meta?: Record<string, unknown>);
}

interface InterruptState {
  pendingTool: { call: ToolUseBlock; reason: string };
  ts: number;
  meta?: Record<string, unknown>;
}

type CheckpointEvent =
  | { type: 'user_input'; content: string; ts: number }
  | { type: 'model_start'; messageCount: number; ts: number }
  | { type: 'model_end'; blocks: ContentBlock[]; usage?: { input: number; output: number }; ts: number }
  | { type: 'tool_start'; call: ToolUseBlock; ts: number }
  | { type: 'tool_end'; result: ToolResultBlock; durationMs: number; ts: number }
  | { type: 'interrupt'; pendingTool: ToolUseBlock; reason: string; ts: number }
  | { type: 'resume'; ts: number }
  | { type: 'run_end'; reason: 'complete' | 'aborted' | 'maxSteps'; ts: number };
```

**InterruptSignal 识别边界（严格）**：framework 只在 `tool.execute()` **直接抛**的 `InterruptSignal` 上走中断流程。

- ✓ `tool.execute(input, signal)` 抛出 → interrupt 流程
- ✗ Plugin `beforeTool`/`afterTool` 抛 → 普通插件故障
- ✗ `ContextManager.shape` 抛 → 整轮 abort
- ✗ `ChatModel.stream` 抛 → 视作 model 故障

**beforeTool 权限/审批替代方案——`withPermission` 工具包装器**：

```ts
function withPermission<T extends Tool>(
  tool: T,
  shouldGate: (input: unknown) => boolean,
  reason: string,
): Tool {
  return {
    ...tool,
    async execute(input, signal) {
      if (shouldGate(input)) throw new InterruptSignal(reason, { tool: tool.name, input });
      return tool.execute(input, signal);
    },
  };
}
```

beforeTool 决策树：
| 意图 | 机制 |
|------|------|
| 直接拒绝，给 LLM 失败原因 | `return { skip: true, result: '...' }` |
| 改 input 后执行 | `return { input: newInput }` |
| 停下来等人决定 | 用 `withPermission` 包装，在 execute 里抛 InterruptSignal |

### 4.4 ContextManager

```ts
interface ContextManagerContext {
  threadId: string;
  signal?: AbortSignal;
  logger: Logger;       // framework 注入
  model: ChatModel;     // framework 注入 agent 配的 model
}

interface ContextManager {
  shape(ctx: ContextManagerContext, messages: readonly Message[]): Message[] | Promise<Message[]>;
}

function pipeContextManagers(...managers: ContextManager[]): ContextManager;
```

设计纪律：
- `shape` 不 mutate 入参；不持久化状态
- `shape` **语义幂等**（resume 路径重走 shape；summarizing 的 LLM 输出允许变化但语义等价）
- 不改 `thread.messages`，只产视图
- `pipeContextManagers` 任一 manager 抛错 → 立刻 throw，不吞、不降级
- CM 暴露 `logger` + `model`（故意不暴露 `checkpointer`——CM 不该读写持久状态；不暴露 `contextManager` 自己——避免循环）

**内置实现**：

| 实现 | 参数 | 职责 |
|------|------|------|
| `passthroughContextManager()` | — | 默认，原样返回 `[...messages]` |
| `slidingWindowContextManager(...)` | `{ maxTurns, keepFirst?: number }` | 保留最近 N 轮 + 前 N 条；配对感知 |
| `tokenBudgetContextManager(...)` | `{ maxTokens, reserveForOutput?, countTokens? }` | token 预算裁剪；三段式 fallback |
| `toolResultTruncator(...)` | `{ maxCharsPerResult }` | 超长 tool_result 截断 + 标记 |
| `summarizingContextManager(...)` | `{ triggerAt, keepRecent, summarizer?, summarizerModel? }` | 摘要压缩；三段式 |

**`summarizingContextManager` 三段式**：
1. 用户传 `summarizer` → 完全自定义
2. 用户传 `summarizerModel` → 内置 prompt + 用户给的 model
3. 都不传 → 用 `ctx.model` + 内置摘要 prompt（开箱即用）

**`tokenBudgetContextManager` 三段式 fallback**：
1. 用户传 `countTokens` → 用户函数
2. `ctx.model.countTokens` → adapter 提供精确实现
3. `Math.ceil(JSON.stringify(messages).length / 4)` → 字符近似兜底

**`slidingWindowContextManager` 的 `keepFirst`**：保留前 N 条（`number`，默认 0）。不识别 system——保留"前 N 条"是纯位置操作。示例：`[system, u1, a1, u2, a2, u3, a3]`, `maxTurns=2, keepFirst=1` → `[system, u2, a2, u3, a3]`。

**`toolResultTruncator` 截断单位**：`maxCharsPerResult`，按 `string.length`（UTF-16 code unit）截。不处理 surrogate pair 半残——99% 场景无所谓，严格用户自己再包一层 CM。

**system prompt 与 CM 交互**：`createAgent` 首次 run 自动插 system prompt 到 `messages[0]`。CM 看到的是已带 system 的完整 messages——CM 自由决定保留/裁剪/替换。`tokenBudget` 从尾向前裁可能裁掉 system；用户想保 system 用 `slidingWindowContextManager({ maxTurns: 999, keepFirst: 1 })` 兜底。

### 4.5 Logger

```ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

interface Logger {
  level: LogLevel;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

function consoleLogger(options?: { level?: LogLevel }): Logger;
```

- 默认 `consoleLogger({ level: 'info' })`
- 输出映射：`debug→console.debug`，`info→console.log`，`warn→console.warn`，`error→console.error`
- `silent`：所有方法 no-op
- framework 内部所有 `console.*` 调用替换为 `this.#logger.*`

### 4.6 内置 Checkpointer

| 实现 | 文件 | 说明 |
|------|------|------|
| `inMemoryCheckpointer()` | `checkpointers/in-memory.ts` | 默认。三个 `Map` 分别存 messages / interrupts / events。实现全部 6 方法 |
| `fileCheckpointer({ dir })` | `checkpointers/file-checkpointer.ts` | `{path}`→`{dir}` breaking。多文件布局 |

**`fileCheckpointer` 文件布局**：
```
${dir}/
├── ${threadId}.state.json        # messages 快照（原子写）
├── ${threadId}.interrupt.json    # 当前 interrupt（可能不存在）
└── ${threadId}.events.jsonl      # 事件追加流（append-only）
```

**原子写实现**（`node:fs/promises`）：
```ts
async function atomicWriteJSON(target: string, data: unknown): Promise<void> {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
```
- 不 fsync——接受极端断电丢最后一次 save，event log 兜底
- `consumeInterrupt` = readFile + unlink；unlink 失败 → throw（防止双消费）
- `appendEvent` 用 `appendFile`，单事件 < PIPE_BUF（4KB）天然原子追加
- 构造时 `mkdir(dir, { recursive: true })` fail fast
- 不主动清理 `.tmp.*` 残留，文档提示可安全删除

**threadId 安全契约**：
- 正则：`/^(?!\.)[A-Za-z0-9_\-.]{1,128}$/` + 额外禁止全点串
- 不通过 → `throw new Error('Invalid threadId: ${id}')`
- **不做静默替换**

### 4.7 HookContext 扩展

```ts
interface HookContext {
  threadId: string;
  signal?: AbortSignal;
  logger: Logger;                  // framework 内化
  checkpointer: Checkpointer;      // framework 内化
  contextManager: ContextManager;  // framework 内化
}
```

三个字段都必需（非可选）。plugin 可读不可越权：
- ✓ `ctx.logger.debug(...)` — 打日志，level 受控
- ✓ `ctx.checkpointer.readEvents(threadId)` — 读事件流做审计
- ✓ `ctx.contextManager.shape(ctx, messages)` — 派生视图做 token 统计
- ✗ `ctx.checkpointer.save(...)` — framework 自动 save，plugin 不双写
- ✗ 用 shape 结果改 thread.messages — shape 是只读派生

### 4.8 `createAgent` 集成

**AgentConfig 新增**：
```ts
interface AgentConfig {
  // ...已有...
  contextManager?: ContextManager;   // 默认 passthroughContextManager()
  logger?: Logger;                   // 默认 consoleLogger({ level: 'info' })
}
```

**Checkpointer 校验**（构造时 fail fast）：
```ts
function validateCheckpointer(cp: Checkpointer): void {
  const hasAppend = typeof cp.appendEvent === 'function';
  const hasRead = typeof cp.readEvents === 'function';
  if (hasAppend !== hasRead) throw new Error('...');
  const hasSaveInt = typeof cp.saveInterrupt === 'function';
  const hasConsumeInt = typeof cp.consumeInterrupt === 'function';
  if (hasSaveInt !== hasConsumeInt) throw new Error('...');
}
```

**Agent.run() 改动**：
1. 默认 `inMemoryCheckpointer()` 永远存在——Checkpointer / ContextManager / Logger 三能力对称，永远非空
2. Loop 每步先 `shaped = await ctx.contextManager.shape(ctx, thread.messages)`，**先于** `plugin.beforeModel`
3. 所有 `console.*` 替换为 `this.#logger.*`
4. 关键事件调 `checkpointer.appendEvent?.(...)`
5. Tool 抛 `InterruptSignal` → 走 interrupt 流程

**Save 时机（5 个，写死不可配置）**：
1. `run()` 入口 push user message 之后
2. 每个 tool 执行完成 push tool_result 之后
3. 每轮 turn 结束（assistant 无 tool_use）之后
4. Interrupt 发生时（messages 末尾停在 assistant(tool_use)）
5. Resume 时 push tool_result 之后

**fork() 语义**：
- 共享所有能力引用（model / tools / plugins / checkpointer / contextManager / logger）
- **强制新 threadId**：不传 → `crypto.randomUUID()`；传父 id → throw
- 默认深拷贝 `structuredClone(thread.messages)`

**变形职责分层**：
```
thread.messages (真实状态)
  → ContextManager.shape(...)   ← 答"哪些 message 进 LLM"（集合选择）
    → plugin.beforeModel(...)   ← 答"message 长什么样"（元素修饰）
      → model.stream(...)
```

### 4.9 既存代码迁移

| 源 | 目标 | 备注 |
|---|---|---|
| `plugins/sliding-window.ts` | `context-managers/sliding-window.ts` | Plugin → ContextManager。接口变了，整体重写 |
| `plugins/console-logger.ts` | `logger.ts` | Plugin → Logger。改为 `consoleLogger()` 工厂 |
| `checkpointers/file-checkpointer.ts` | 同名重写 | `{path}` → `{dir}`，新增 interrupt + event 方法 |

**`packages/framework/src/plugins/` 整个目录删除**——framework 零内置 plugin。

### 4.10 ChatModel 非破坏性扩展（M1 包）

```ts
interface ChatModel {
  stream(messages: readonly Message[], options?: ChatModelOptions): AsyncIterable<AIMessageChunk>;
  countTokens?(messages: readonly Message[]): number | Promise<number>;
}
```

- 可选方法，旧 adapter 编译通过
- `adapter-anthropic` M4 范围内不实现该方法（走字符近似 fallback）
- 签名是 `(messages) → Promise<number>`，不是 `(text) => number`——model 知道自己的 tokenizer，算整批 messages 而非单条 content

### 4.11 Plugin pipeline 错误处理

| 钩子类型 | 抛错行为 |
|----------|----------|
| `before*` | 短路——第 N 个抛 → 第 N+1 起不调；整轮 abort，异常传给调用方 |
| `after*` | 继续——第 N 个抛 → `logger.warn(pluginName, err)`；第 N+1 起继续调 |

不引入可配置错误策略——规则由 hook 类型（transformer vs observer）决定，这是 hook 设计根本。

---

## 五、包结构

```text
packages/framework/src/
├── create-agent.ts              # 改：resume / ContextManager / Logger / Interrupt
├── create-agent.test.ts         # 改：补 resume / interrupt / contextManager / logger 用例
├── thread.ts                    # 不变
├── plugin.ts                    # 改：HookContext 增三字段
├── plugin.test.ts               # 改：补 HookContext 新字段断言
├── checkpointer.ts              # 改：InterruptSignal / InterruptState / CheckpointEvent / 4 新方法
├── logger.ts                    # 新
├── logger.test.ts               # 新
├── context-manager.ts           # 新：接口 + pipeContextManagers
├── context-manager.test.ts      # 新
├── context-managers/
│   ├── passthrough.ts           # 新
│   ├── passthrough.test.ts
│   ├── sliding-window.ts        # 迁自 plugins/，重写
│   ├── sliding-window.test.ts
│   ├── token-budget.ts          # 新
│   ├── token-budget.test.ts
│   ├── tool-result-truncator.ts # 新
│   ├── tool-result-truncator.test.ts
│   ├── summarizing.ts           # 新
│   └── summarizing.test.ts
├── checkpointers/
│   ├── in-memory.ts             # 新
│   ├── in-memory.test.ts
│   ├── file-checkpointer.ts     # 重写（dir layout）
│   └── file-checkpointer.test.ts
├── plugins/                     # 删除整目录
└── index.ts                     # 改：导出新类型
```

---

## 六、技术契约不做（invariant）

- **不内置 LLM 摘要** — `summarizingContextManager` 的 `summarizer` 可选；默认用 `ctx.model` + 内置 prompt
- **不内置 model-specific tokenizer** — `tokenBudgetContextManager` 的 `countTokens` 可选；默认字符近似
- **不做 `redisCheckpointer`** — 独立适配包，不入 framework
- **`fileCheckpointer` 不静默替换非法 threadId** — 直接 throw
- **ContextManager 不二次校验** `shape` 返回值的合法性 — fail fast，由用户保证 tool_use/tool_result 配对
- **`InterruptSignal` 只在 `tool.execute` 抛出时被识别** — 其他位置抛按普通故障处理
- **不优化 save 频率** — 保持每 tool + 每 turn save；用户可自行包装 checkpointer debounce
- **不引入 plugin 错误策略配置** — before* 短路 / after* 继续，由 hook 类型决定
- **`adapter-anthropic` M4 不实现 `countTokens`** — 字符近似兜底够用；未来增量加

---

## 七、测试要求

### 7.1 Checkpointer

| 文件 | 用例 |
|------|------|
| `in-memory.test.ts` | save/load 往返；saveInterrupt/consumeInterrupt 往返（consume 后再调返回 null）；appendEvent/readEvents 往返；load 不存在返回 null |
| `file-checkpointer.test.ts` | 同上 + dir layout 正确 + atomic write（中断模拟）+ thread 隔离 + threadId 非法字符 throw + 全点串 throw + 以点开头 throw |

### 7.2 Logger

| 文件 | 用例 |
|------|------|
| `logger.test.ts` | level 过滤（info 不输出 debug；warn 不输出 info/debug；silent 全不输出）；各方法 console 目标正确 |

### 7.3 ContextManager

| 文件 | 用例 |
|------|------|
| `passthrough.test.ts` | 返回新数组；不共享引用；不 mutate 入参 |
| `sliding-window.test.ts` | 保留 N 轮；`keepFirst` 数字语义；配对感知（删 assistant 同步删 tool_result）；不孤儿 block；不足时全保留；不 mutate |
| `token-budget.test.ts` | 从尾累加；超 `maxTokens - reserveForOutput` 截断；用户 countTokens → ctx.model.countTokens → 字符近似三段式 fallback；Promise countTokens 正确 await |
| `tool-result-truncator.test.ts` | 超长截断 + `...[truncated, N chars]` 标记；短的不变；tool_use/tool_result 配对不变 |
| `summarizing.test.ts` | 触发条件满足时调 summarizer；不满足时透传；不传 summarizer 用 ctx.model + 内置 prompt；传 summarizerModel 用内置 prompt + 用户 model |
| `context-manager.test.ts` | `pipeContextManagers` 顺序；前一个输出=后一个输入；任一 manager 抛错 → pipe 立即 throw（不吞） |

### 7.4 create-agent（补充）

| 场景 | 断言 |
|------|------|
| resume approved | tool_result 注入 → model 收到 → 继续完成 |
| resume denied | tool_result `is_error=true`、content 含 "denied" 或自定义 message |
| resume 无 pending interrupt | throw "No pending interrupt for this thread" |
| tool 抛 `InterruptSignal` | yield `{ type: 'interrupted', payload }`；messages 含完整 assistant(tool_use)；save 在 saveInterrupt 之前 |
| tool 抛 `InterruptSignal` 但 checkpointer 不支持 | throw 带可操作 message |
| ContextManager 注入 | `shape` 先于 `plugin.beforeModel`；shape 返回值不污染 `thread.messages` |
| Logger 注入 | framework 内部 warn 走 `logger.warn` 而非 `console.warn` |
| HookContext 三能力 | plugin 可读 `ctx.logger` / `ctx.checkpointer` / `ctx.contextManager`；都非可选 |
| appendEvent | tool_start / tool_end / interrupt / resume / run_end 事件被记录 |
| `#running` 保护 | 同一 agent 并发 run/resume 抛错 |
| fork 默认新 threadId | 不传 id 自动 uuid |
| fork 传父 id | throw |
| checkpointer 能力不成对 | createAgent 时 throw |

### 7.5 回归

M1/M2/M3 已有测试全部继续通过（无退化）。

---

## 八、CI Gate

```sh
bun run format && bun run lint && bun run typecheck && bun run test && bun run build
```

全绿才能合并。

---

## 九、验收清单

- [ ] `bun run format && bun run lint && bun run typecheck && bun run test && bun run build` 全绿
- [ ] `AgentEvent = { type: 'message' | 'interrupted', payload }` 实现；`Interrupt` 独立类型
- [ ] `Agent.resume(command)` 实现，`ResumeCommand = { approved, message? }`
- [ ] `#runLoop()` 抽取，入口契约严格；`#executeOne` 布尔返回值传 interrupt
- [ ] `InterruptSignal` 实现，且**仅**在 `tool.execute` 抛时走 interrupt 流程
- [ ] Checkpointer 接口 6 方法 + 能力成对校验；`CheckpointEvent` 命名
- [ ] `inMemoryCheckpointer` + `fileCheckpointer({ dir })` 全实现
- [ ] `fileCheckpointer` 原子写（tmp+rename）+ threadId 安全校验（禁止全点/以点开头）
- [ ] `ChatModel.countTokens?` 可选方法定义（非破坏性扩展）
- [ ] ContextManager 接口 + `ContextManagerContext.model`/`logger` + 5 内置实现 + `pipeContextManagers`
- [ ] `pipeContextManagers` 错误不吞（任一 manager throw → pipe throw）
- [ ] Logger 接口 + `consoleLogger` + level 过滤
- [ ] `plugins/` 目录已删；sliding-window 迁到 `context-managers/`；console-logger 迁到 `logger.ts`
- [ ] `createAgent` 接受 `contextManager` 和 `logger`，默认值生效；默认 `inMemoryCheckpointer`
- [ ] `HookContext` 暴露 `logger` / `checkpointer` / `contextManager` 三必需字段
- [ ] `fork()` 强制新 threadId（同 id throw，无 id auto-uuid）
- [ ] M1/M2/M3 已有测试全部通过
- [ ] M4 retro 文档已写（`docs/superpowers/specs/YYYY-MM-DD-m4-retro.md`），含 Delivered / Actual vs Spec / Code Size / Tests / Lessons

---

**Spec 结束。**
