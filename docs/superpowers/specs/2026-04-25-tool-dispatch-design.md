# Tool Dispatch 解耦设计 Spec

## 背景

当前 `Agent.ts` (~790 行) 中：
- `executeToolCall()` 直接调用 tool，手动处理 `requiresContext`、超时、输出截断
- `runAgentLoop()` 内有 ~260 行 tool 执行代码，分散在三种并行模式中
- Tool 无法感知执行环境（main / sub_agent）
- 新增 tool 级横切关注点（日志、权限、缓存）必须修改 Agent.ts

## 目标

将 tool 执行逻辑从 Agent 中完全解耦，内聚到独立的 `ToolDispatcher` 模块。

---

## 1. 核心类型

### 1.1 ToolContext — 统一工具执行上下文

```typescript
// src/agent/tool-dispatch/types.ts

export interface ToolContext {
  /** Abort signal — 来自 agent loop 或用户取消 */
  signal: AbortSignal;

  /** 当前 agent 上下文的只读快照（TypeScript 层面只读） */
  agentContext: Readonly<AgentContext>;

  /** 当前 token budget 快照 */
  budget: {
    /** 剩余可用 token (effectiveLimit - currentUsage) */
    remaining: number;
    /** usage ratio (0-1) */
    usageRatio: number;
  };

  /** 执行环境标识 */
  environment: {
    agentType: 'main' | 'sub_agent';
    /** sub agent 的 ID — 仅 sub agent 环境有值 */
    agentId?: string;
    /** 当前 working directory */
    cwd: string;
  };

  /** 工具间通信的 metadata bag — 每个 tool 有独立副本 */
  metadata: Map<string, unknown>;

  /** 向 agent 提交副作用的收集通道 */
  sink: ToolSink;
}
```

### 1.2 ToolSink — 收集式副作用输出

```typescript
/**
 * ToolSink — tool 的副作用输出通道（收集式）。
 * Tool 执行过程中调用这些方法收集数据，Dispatcher 在 tool 完成后统一处理。
 */
export interface ToolSink {
  /** 报告 todo 状态变更 */
  updateTodos(todos: TodoItem[]): void;

  /** 提交需要被记忆系统提取的关键事件 */
  emitMemoryHint(hint: string): void;

  /** 提交 tool 执行过程中的结构化日志 */
  log(level: 'debug' | 'info' | 'warn', message: string): void;

  /** Dispatcher 执行后读取收集的结果 */
  readonly _todoUpdates?: TodoItem[];
  readonly _memoryHints: string[];
  readonly _logs: Array<{ level: string; message: string; timestamp: number }>;
}
```

### 1.3 ToolEvent — 工具执行事件流

```typescript
export type ToolEvent =
  | { type: 'tool:start'; toolCall: ToolCall; index: number }
  | { type: 'tool:progress'; toolCall: ToolCall; message: string }
  | { type: 'tool:result'; toolCall: ToolCall; result: ToolExecutionResult }
  | { type: 'tool:error'; toolCall: ToolCall; error: Error; recoverable: boolean };

export interface ToolExecutionResult {
  /** Tool 返回的内容（已经过截断处理） */
  content: string;
  /** 原始返回值（截断前） */
  rawContent?: unknown;
  /** 执行耗时 ms */
  durationMs: number;
  /** 是否出错 */
  isError: boolean;
  /** 从 ToolContext.metadata 序列化的元数据 */
  metadata?: Record<string, unknown>;
  /** 从 ToolSink._todoUpdates 收集的 todo 更新 */
  todoUpdates?: TodoItem[];
}
```

### 1.4 DispatchOptions

```typescript
export interface DispatchOptions {
  /** 并行执行 tool calls */
  parallel: boolean;
  /** 边完成边 yield — false = 全部完成后批量 yield */
  yieldAsCompleted: boolean;
  /** 单个 tool 超时 ms */
  toolTimeoutMs: number;
  /** 输出截断阈值 */
  maxOutputChars: number;
  /** 错误策略 */
  errorStrategy: 'continue' | 'halt';
}
```

### 1.5 统一 ToolImplementation 签名

修改 `src/types.ts`：

```typescript
export interface ToolImplementation {
  getDefinition(): Tool;
  /**
   * 统一签名：所有 tool 都接收 ToolContext。
   * 删除 requiresContext 字段。
   */
  execute(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

// 删除字段：requiresContext?: boolean;
```

**迁移策略**：不需要 context 的 tool 直接忽略第二个参数。旧代码零改动即可兼容。

### 1.6 ToolMiddleware 接口

```typescript
// src/agent/tool-dispatch/middleware.ts

export interface ToolMiddleware {
  /** Middleware 名称（用于调试） */
  name: string;

  /**
   * 拦截 tool 执行。
   * 洋葱模型：
   * - handle 调用 next() 前的代码先执行
   * - next() 触发内层 middleware 或 tool.execute
   * - next() 返回后的代码后执行
   */
  handle(
    toolCall: ToolCall,
    ctx: ToolContext,
    next: () => Promise<unknown>,
  ): Promise<unknown>;
}
```

---

## 2. ToolDispatcher 设计

```typescript
// src/agent/tool-dispatch/dispatcher.ts

export class ToolDispatcher {
  constructor(
    private registry: ToolRegistry,
    private middlewares: ToolMiddleware[] = [],
  ) {}

  /**
   * Dispatch a batch of tool calls, yield events as they execute.
   * 这是 Agent 唯一需要调用的入口方法。
   */
  async *dispatch(
    toolCalls: ToolCall[],
    baseCtx: ToolContext,
    options: DispatchOptions,
  ): AsyncGenerator<ToolEvent> {
    if (options.parallel && options.yieldAsCompleted) {
      yield* this.dispatchParallelStreaming(toolCalls, baseCtx, options);
    } else if (options.parallel) {
      yield* this.dispatchParallelBatch(toolCalls, baseCtx, options);
    } else {
      yield* this.dispatchSequential(toolCalls, baseCtx, options);
    }
  }

  /**
   * 执行单个 tool — 应用 middleware 链 + 超时 + 序列化 + 副作用收集
   */
  private async executeSingle(
    toolCall: ToolCall,
    baseCtx: ToolContext,
    options: DispatchOptions,
  ): Promise<ToolExecutionResult> {
    const tool = this.registry.get(toolCall.name);
    if (!tool) {
      return {
        content: `Error: Tool '${toolCall.name}' not found.`,
        durationMs: 0,
        isError: true,
      };
    }

    // 每个 tool 有独立的 metadata Map 副本，隔离并行执行
    const toolCtx: ToolContext = {
      ...baseCtx,
      metadata: new Map(baseCtx.metadata),
      sink: createToolSink(),  // 创建新的 sink 实例
    };

    // 构建 middleware 洋葱链
    // 注册顺序 = 外层到内层（第一个注册的最先执行）
    const chain = this.buildMiddlewareChain(tool, toolCall, toolCtx);

    const startTime = Date.now();
    try {
      const rawResult = await this.withTimeout(
        chain(),
        options.toolTimeoutMs,
        toolCall.name,
      );

      const content = this.serializeAndTruncate(rawResult, options.maxOutputChars);
      const durationMs = Date.now() - startTime;

      // 从 sink 收集副作用
      const sink = toolCtx.sink as ToolSinkImpl;

      return {
        content,
        rawContent: rawResult,
        durationMs,
        isError: false,
        metadata: Object.fromEntries(toolCtx.metadata),
        todoUpdates: sink._todoUpdates,
      };
    } catch (error) {
      return {
        content: `Error executing '${toolCall.name}': ${error instanceof Error ? error.message : String(error)}`,
        durationMs: Date.now() - startTime,
        isError: true,
      };
    }
  }

  private buildMiddlewareChain(
    tool: ToolImplementation,
    toolCall: ToolCall,
    ctx: ToolContext,
  ): () => Promise<unknown> {
    // 洋葱模型：最外层 middleware 先执行
    // 倒序遍历 middleware，从内向外包装
    let current = () => tool.execute(toolCall.arguments, ctx);
    for (const mw of [...this.middlewares].reverse()) {
      const next = current;
      current = () => mw.handle(toolCall, ctx, next);
    }
    return current;
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Tool '${toolName}' timed out after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }

  private serializeAndTruncate(result: unknown, maxChars: number): string {
    const str = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    if (str.length <= maxChars) return str;
    return str.slice(0, maxChars) + `\n\n--- Truncated after ${maxChars} chars ---`;
  }

  // 三种执行模式
  private async *dispatchParallelStreaming(toolCalls: ToolCall[], baseCtx: ToolContext, options: DispatchOptions): AsyncGenerator<ToolEvent>
  private async *dispatchParallelBatch(toolCalls: ToolCall[], baseCtx: ToolContext, options: DispatchOptions): AsyncGenerator<ToolEvent>
  private async *dispatchSequential(toolCalls: ToolCall[], baseCtx: ToolContext, options: DispatchOptions): AsyncGenerator<ToolEvent>
}
```

### Middleware 执行顺序

**注册顺序 = 执行顺序（先注册的在外层）**

推荐默认注册顺序：
```typescript
[
  LoggingMiddleware,      // 最外层，捕获完整执行时间
  PermissionMiddleware,   // 权限检查
  BudgetGuardMiddleware,  // token 预算检查
  ReadCacheMiddleware,     // 最内层，读缓存贴近实际 tool 调用
]
```

执行流程：
```
Logging.handle → Permission.handle → BudgetGuard.handle → ReadCache.handle → tool.execute
                                                                           ↓
Logging.handle ← Permission.handle ← BudgetGuard.handle ← ReadCache.handle ←
```

---

## 3. Agent.ts 改造

### 构造函数集成

```typescript
export class Agent {
  private dispatcher: ToolDispatcher;

  constructor(options: {
    provider: Provider;
    contextManager: ContextManager;
    hooks?: AgentHooks;
    config: AgentConfig;
    toolRegistry?: ToolRegistry;
    /** @deprecated Use hooks.beforeModel instead */
    middleware?: Middleware[];
    toolMiddlewares?: ToolMiddleware[];  // 新增
  }) {
    // ... existing ...

    this.dispatcher = new ToolDispatcher(
      this.toolRegistry,
      options.toolMiddlewares ?? [],  // 默认为空，向后兼容
    );
  }
```

### runAgentLoop 中的替换

在 `runAgentLoop` 的 tool 执行部分（~500-700 行），替换为：

```typescript
// ===== 工具执行：~260 行 → ~30 行 =====
const toolCtx = this.buildToolContext(resultContext, signal);
const dispatchOptions: DispatchOptions = {
  parallel: config.parallelToolExecution,
  yieldAsCompleted: config.yieldEventsAsToolsComplete,
  toolTimeoutMs: config.toolTimeoutMs,
  maxOutputChars: config.maxToolOutputChars,
  errorStrategy: config.toolErrorStrategy,
};

for await (const event of this.dispatcher.dispatch(tool_calls, toolCtx, dispatchOptions)) {
  switch (event.type) {
    case 'tool:start':
      yield {
        type: 'tool_call_start',
        toolCall: event.toolCall,
        turnIndex,
      } satisfies AgentEvent;
      break;

    case 'tool:result':
      yield {
        type: 'tool_call_result',
        toolCall: event.toolCall,
        result: event.result.content,
        error: event.result.isError ? new Error(event.result.content) : undefined,
        durationMs: event.result.durationMs,
        isError: event.result.isError,
        turnIndex,
      } satisfies AgentEvent;

      // 添加 tool result 到 context
      this.contextManager.addMessage({
        role: 'tool',
        content: event.result.content,
        tool_call_id: event.toolCall.id,
        name: event.toolCall.name,
      });

      // 处理 todo 更新
      if (event.result.todoUpdates) {
        this.contextManager.setTodoState({
          todos: event.result.todoUpdates,
          // ... 其他字段保持不变
        });
      }

      // 错误策略
      if (event.result.isError && config.toolErrorStrategy === 'halt') {
        throw new Error(event.result.content);
      }
      break;
  }
}
// ===== 替换结束 =====
```

### 新增和删除的方法

**新增私有方法：**
```typescript
private buildToolContext(agentCtx: AgentContext, signal: AbortSignal): ToolContext {
  return {
    signal,
    agentContext: Object.freeze({ ...agentCtx }),
    budget: {
      remaining: this.contextManager.getRemainingBudget(),
      usageRatio: this.contextManager.getBudgetUsageRatio(),
    },
    environment: {
      agentType: 'main',
      cwd: process.cwd(),
    },
    metadata: new Map(),
    sink: createToolSink(),
  };
}
```

**删除私有方法：**
- `executeToolCall()`
- `truncateOutput()`

---

## 4. SubAgentTool 适配

```typescript
// src/agent/sub-agent-tool.ts

export class SubAgentTool implements ToolImplementation {
  // 删除：requiresContext = true;

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const task = params.task as string;
    const signal = ctx.signal;

    // 防止递归：只有 main agent 才能 spawn sub_agent
    if (ctx.environment.agentType === 'sub_agent') {
      return 'Error: sub_agent cannot spawn another sub_agent';
    }

    // ... 创建 sub agent ...

    // Sub agent 内部的 ToolContext：environment.agentType = 'sub_agent'
    for await (const event of subAgent.runAgentLoop(...)) {
      // 事件冒泡通过 ctx.sink.log() 输出，不产生新的 ToolEvent 类型
      ctx.sink.log('debug', `[sub:${agentId}] ${event.type}`);
    }

    // ...
  }
}
```

---

## 5. 内置 ToolMiddleware (Phase 4)

### 5.1 LoggingMiddleware

```typescript
export class LoggingMiddleware implements ToolMiddleware {
  name = 'logging';

  async handle(toolCall: ToolCall, ctx: ToolContext, next: () => Promise<unknown>) {
    const start = Date.now();
    ctx.sink.log('debug', `[${toolCall.name}] start`);
    try {
      const result = await next();
      ctx.sink.log('info', `[${toolCall.name}] done in ${Date.now() - start}ms`);
      return result;
    } catch (error) {
      ctx.sink.log('warn', `[${toolCall.name}] failed: ${error}`);
      throw error;
    }
  }
}
```

### 5.2 PermissionMiddleware

```typescript
export class PermissionMiddleware implements ToolMiddleware {
  name = 'permission';
  constructor(private rules: { denyInSubAgent: string[] }) {}

  async handle(toolCall: ToolCall, ctx: ToolContext, next: () => Promise<unknown>) {
    if (ctx.environment.agentType === 'sub_agent'
        && this.rules.denyInSubAgent.includes(toolCall.name)) {
      throw new Error(`Tool '${toolCall.name}' is not allowed in sub agent context`);
    }
    return next();
  }
}
```

### 5.3 BudgetGuardMiddleware

```typescript
export class BudgetGuardMiddleware implements ToolMiddleware {
  name = 'budget-guard';

  async handle(toolCall: ToolCall, ctx: ToolContext, next: () => Promise<unknown>) {
    if (ctx.budget.usageRatio > 0.85) {
      ctx.sink.log('warn', `Budget tight (${(ctx.budget.usageRatio * 100).toFixed(0)}%)`);
    }
    return next();
  }
}
```

### 5.4 ReadCacheMiddleware

```typescript
export class ReadCacheMiddleware implements ToolMiddleware {
  name = 'read-cache';
  private cache = new Map<string, { result: unknown; timestamp: number }>();

  async handle(toolCall: ToolCall, ctx: ToolContext, next: () => Promise<unknown>) {
    if (toolCall.name !== 'read') return next();

    const key = `read:${toolCall.arguments.path}:${toolCall.arguments.start_line}:${toolCall.arguments.end_line}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < 30_000) {
      return cached.result;
    }

    const result = await next();
    this.cache.set(key, { result, timestamp: Date.now() });
    return result;
  }
}
```

---

## 6. 文件结构

```
src/agent/tool-dispatch/
├── index.ts                 # Re-exports
├── types.ts                 # ToolContext, ToolSink, ToolEvent, ToolExecutionResult, DispatchOptions
├── dispatcher.ts            # ToolDispatcher — 核心编排
├── middleware.ts            # ToolMiddleware 接口
└── middlewares/             # 内置中间件实现
    ├── logging.ts
    ├── permission.ts
    ├── budget-guard.ts
    └── read-cache.ts
```

---

## 7. 迁移计划

### Phase 1: 基础设施（无行为变化）
- [ ] 创建 `types.ts` — 所有类型定义
- [ ] 创建 `dispatcher.ts` — 从 Agent 搬迁三种执行模式
- [ ] 创建 `middleware.ts` — ToolMiddleware 接口
- [ ] **测试**：Dispatcher 单元测试，三种执行模式的事件顺序正确性

### Phase 2: Agent.ts 对接
- [ ] Agent 构造函数接收 `ToolDispatcher`
- [ ] `runAgentLoop` 中替换 tool 执行代码
- [ ] 删除 `Agent.executeToolCall()`
- [ ] 删除 `Agent.truncateOutput()`
- [ ] **测试**：Agent 集成测试，验证与 Phase 1 行为一致

### Phase 3: ToolImplementation 签名统一
- [ ] 修改 `src/types.ts` 中 `ToolImplementation.execute` 签名
- [ ] 删除 `requiresContext` 字段
- [ ] SubAgentTool 改为从 `ctx` 取值
- [ ] TodoWriteTool 改为从 `ctx.sink.updateTodos()` 输出
- [ ] **测试**：每个 tool 的单元测试通过

### Phase 4: 内置 ToolMiddleware
- [ ] LoggingMiddleware
- [ ] PermissionMiddleware
- [ ] BudgetGuardMiddleware
- [ ] ReadCacheMiddleware
- [ ] **测试**：middleware 集成测试

---

## 8. 兼容性保证

| 组件 | 是否需要修改 | 说明 |
|------|-------------|------|
| `bin/my-agent.ts` (headless CLI) | ❌ 不需要 | 只使用 `agent.runAgentLoop()` 公开 API |
| `src/runtime.ts` | ❌ 不需要 | 只创建 Agent，不关心内部实现 |
| TUI 组件 | ❌ 不需要 | 只消费 `AgentEvent` |
| 普通 tool (bash/read/grep...) | ❌ 不需要 | 忽略第二个参数即可 |
| SubAgentTool | ✅ 需要 | 从 `ctx` 取 signal 和 agentType |
| TodoWriteTool | ✅ 需要 | 从 `ctx.sink` 输出 todo 更新 |

**对外 API 100% 向后兼容。**
