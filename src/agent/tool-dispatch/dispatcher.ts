import type { ToolCall, ToolImplementation } from '../../types';
import type { ToolRegistry } from '../tool-registry';
import type { ToolMiddleware } from './middleware';
import type { ToolContext, ToolEvent, ToolExecutionResult, DispatchOptions } from './types';
import { createToolSink } from './types';

export class ToolDispatcher {
  constructor(
    private registry: ToolRegistry,
    private middlewares: ToolMiddleware[] = [],
  ) {}

  /**
   * Dispatch a batch of tool calls, yield events as they execute.
   * This is the primary entry point for the Agent.
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
      // "Tool not found" is a handled condition, not a runtime error
      return {
        content: `Error: Tool '${toolCall.name}' not found.`,
        durationMs: 0,
        isError: false,
      };
    }

    // 每个 tool 有独立的 metadata Map 副本，隔离并行执行
    const toolCtx: ToolContext = {
      ...baseCtx,
      metadata: new Map(baseCtx.metadata),
      sink: createToolSink(),
    };

    // 构建 middleware 洋葱链
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
      const sink = toolCtx.sink;

      const result: any = {
        content,
        rawContent: rawResult,
        durationMs,
        isError: false,
        metadata: Object.fromEntries(toolCtx.metadata),
      };
      if (sink._todoUpdates) {
        result.todoUpdates = sink._todoUpdates;
      }
      return result;
    } catch (error) {
      return {
        content: `Error executing '${toolCall.name}': ${error instanceof Error ? error.message : String(error)}`,
        durationMs: Date.now() - startTime,
        isError: true,
      };
    }
  }

  /**
   * 构建 middleware 洋葱链
   * 注册顺序 = 外层到内层（第一个注册的最先执行）
   */
  private buildMiddlewareChain(
    tool: ToolImplementation,
    toolCall: ToolCall,
    ctx: ToolContext,
  ): () => Promise<unknown> {
    let current = () => tool.execute(toolCall.arguments, ctx);
    for (const mw of [...this.middlewares].reverse()) {
      const next = current;
      current = () => mw.handle(toolCall, ctx, next);
    }
    return current;
  }

  /**
   * Promise 超时包装
   */
  private async withTimeout<T>(promise: Promise<T>, ms: number, toolName: string): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Tool '${toolName}' timed out after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * 只对 string 类型截断，其他类型原样返回以避免大对象 JSON.stringify 的阻塞
   */
  private serializeAndTruncate(result: unknown, maxChars: number): unknown {
    if (typeof result === 'string') {
      if (result.length <= maxChars) return result;
      return result.slice(0, maxChars) + `\n\n--- Truncated after ${maxChars} characters ---`;
    }
    // 非 string 类型原样返回（read/grep/glob/ls 等工具返回的是对象）
    // TUI 的 smartSummarize 依赖这些对象来智能格式化
    return result;
  }

  /**
   * Sequential execution: execute tools one after another
   */
  private async *dispatchSequential(
    toolCalls: ToolCall[],
    baseCtx: ToolContext,
    options: DispatchOptions,
  ): AsyncGenerator<ToolEvent> {
    for (const [index, toolCall] of toolCalls.entries()) {
      yield { type: 'tool:start', toolCall, index };
      const result = await this.executeSingle(toolCall, baseCtx, options);
      yield { type: 'tool:result', toolCall, result };
    }
  }

  /**
   * Parallel batch execution: all start at once, all results yielded at the end
   */
  private async *dispatchParallelBatch(
    toolCalls: ToolCall[],
    baseCtx: ToolContext,
    options: DispatchOptions,
  ): AsyncGenerator<ToolEvent> {
    const results = await Promise.allSettled(
      toolCalls.map(toolCall => this.executeSingle(toolCall, baseCtx, options)),
    );

    for (const [index, toolCall] of toolCalls.entries()) {
      yield { type: 'tool:start', toolCall, index };

      const resultItem = results[index];
      let result: ToolExecutionResult;
      if (!resultItem) {
        result = {
          content: 'Error: Tool execution result not found',
          durationMs: 0,
          isError: true,
        };
      } else if (resultItem.status === 'fulfilled') {
        result = resultItem.value;
      } else {
        const error = resultItem.reason instanceof Error
          ? resultItem.reason
          : new Error(String(resultItem.reason));
        result = {
          content: `Error: ${error.message}`,
          durationMs: 0,
          isError: true,
        };
      }

      yield { type: 'tool:result', toolCall, result };
    }
  }

  /**
   * Parallel streaming execution: all start at once, results yielded as they complete.
   * Uses ReadableStream to eliminate the race condition inherent in hand-rolled
   * resolveNext patterns — the stream's internal queuing handles the case where
   * a producer completes before the consumer calls read().
   */
  private async *dispatchParallelStreaming(
    toolCalls: ToolCall[],
    baseCtx: ToolContext,
    options: DispatchOptions,
  ): AsyncGenerator<ToolEvent> {
    // First, yield all start events immediately
    for (const [index, toolCall] of toolCalls.entries()) {
      yield { type: 'tool:start', toolCall, index };
    }

    let controller!: ReadableStreamDefaultController<ToolEvent>;
    const stream = new ReadableStream<ToolEvent>({
      start(c) { controller = c; },
    });

    const promises = toolCalls.map(async (toolCall) => {
      try {
        const result = await this.executeSingle(toolCall, baseCtx, options);
        controller.enqueue({
          type: 'tool:result',
          toolCall,
          result,
        });
      } catch (error) {
        try {
          controller.error(error);
        } catch {
          // Controller might already be closed — ignore
        }
      }
    });

    const onAbort = () => {
      try { controller.close(); } catch {}
    };
    baseCtx.signal.addEventListener('abort', onAbort, { once: true });

    Promise.allSettled(promises).finally(() => {
      try { controller.close(); } catch {}
      baseCtx.signal.removeEventListener('abort', onAbort);
    });

    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
      await Promise.allSettled(promises);
    }
  }
}
