import type { ToolCall, ToolImplementation } from '../../types';
import type { ToolRegistry } from '../tool-registry';
import type { ToolMiddleware } from './middleware';
import type { ToolContext, ToolEvent, ToolExecutionResult, DispatchOptions } from './types';
import { createToolSink } from './types';
import { debugLog } from '../../utils/debug';

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
    const t0 = performance.now();
    const method = options.parallel
      ? (options.yieldAsCompleted ? 'parallel-streaming' : 'parallel-batch')
      : 'sequential';
    debugLog(
      `[dispatcher] dispatch: ${toolCalls.length} tools, ${method}, ` +
      `timeout=${options.toolTimeoutMs}ms, maxChars=${options.maxOutputChars}`,
    );
    if (options.parallel && options.yieldAsCompleted) {
      yield* this.dispatchParallelStreaming(toolCalls, baseCtx, options);
    } else if (options.parallel) {
      yield* this.dispatchParallelBatch(toolCalls, baseCtx, options);
    } else {
      yield* this.dispatchSequential(toolCalls, baseCtx, options);
    }
    debugLog(`[dispatcher] dispatch done: elapsed=${(performance.now() - t0).toFixed(0)}ms`);
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

    // 创建超时 AbortController，合并外部信号
    const originalSignal = toolCtx.signal;
    const timeoutController = new AbortController();
    const onExternalAbort = () => timeoutController.abort();
    originalSignal.addEventListener('abort', onExternalAbort, { once: true });
    toolCtx.signal = timeoutController.signal;

    // 构建 middleware 洋葱链
    const chain = this.buildMiddlewareChain(tool, toolCall, toolCtx);

    debugLog(`[dispatcher] executeSingle START: ${toolCall.name}#${toolCall.id} t=${performance.now().toFixed(0)}`);
    const startTime = Date.now();
    try {
      const rawResult = await this.withTimeout(
        chain(),
        options.toolTimeoutMs,
        toolCall.name,
        timeoutController,
      );

      const content = this.serializeAndTruncate(rawResult, options.maxOutputChars);
      const durationMs = Date.now() - startTime;
      debugLog(`[dispatcher] executeSingle DONE: ${toolCall.name}#${toolCall.id} duration=${durationMs}ms isError=false`);

      // 从 sink 收集副作用
      const sink = toolCtx.sink;

      const result: ToolExecutionResult = {
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
      const durationMs = Date.now() - startTime;
      debugLog(`[dispatcher] executeSingle ERROR: ${toolCall.name}#${toolCall.id} duration=${durationMs}ms error=${error instanceof Error ? error.message : String(error)}`);
      return {
        content: `Error executing '${toolCall.name}': ${error instanceof Error ? error.message : String(error)}`,
        durationMs,
        isError: true,
      };
    } finally {
      originalSignal.removeEventListener('abort', onExternalAbort);
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
  private async withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    toolName: string,
    controller?: AbortController,
  ): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        debugLog(`[dispatcher] TIMEOUT: ${toolName} after ${ms}ms`);
        controller?.abort();
        reject(new Error(`Tool '${toolName}' timed out after ${ms}ms`));
      }, ms);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      // Suppress unhandled rejection from the original promise after timeout wins the race
      promise.catch(() => {});
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
      debugLog(`[dispatcher] sequential YIELD start: ${toolCall.name}#${toolCall.id} index=${index} t=${performance.now().toFixed(0)}`);
      yield { type: 'tool:start', toolCall, index };
      const result = await this.executeSingle(toolCall, baseCtx, options);
      debugLog(`[dispatcher] sequential YIELD result: ${toolCall.name}#${toolCall.id} index=${index} t=${performance.now().toFixed(0)}`);
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
    const batchStart = performance.now();
    debugLog(`[dispatcher] parallel-batch EXECUTE all: ${toolCalls.map(tc => `${tc.name}#${tc.id}`).join(', ')} t=${batchStart.toFixed(0)}`);
    const results = await Promise.allSettled(
      toolCalls.map(toolCall => this.executeSingle(toolCall, baseCtx, options)),
    );
    debugLog(`[dispatcher] parallel-batch ALL done: elapsed=${(performance.now() - batchStart).toFixed(0)}ms`);

    for (const [index, toolCall] of toolCalls.entries()) {
      debugLog(`[dispatcher] parallel-batch YIELD start+result: ${toolCall.name}#${toolCall.id} index=${index}`);
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
    const streamingStart = performance.now();
    // First, yield all start events immediately
    for (const [index, toolCall] of toolCalls.entries()) {
      debugLog(`[dispatcher] streaming YIELD start: ${toolCall.name}#${toolCall.id} index=${index} t=${performance.now().toFixed(0)}`);
      yield { type: 'tool:start', toolCall, index };
    }
    debugLog(`[dispatcher] streaming all starts yielded: count=${toolCalls.length} elapsed=${(performance.now() - streamingStart).toFixed(0)}ms`);

    let controller!: ReadableStreamDefaultController<ToolEvent>;
    const stream = new ReadableStream<ToolEvent>({
      start(c) { controller = c; },
    });

    const promises = toolCalls.map(async (toolCall) => {
      try {
        const result = await this.executeSingle(toolCall, baseCtx, options);
        debugLog(`[dispatcher] streaming ENQUEUE result: ${toolCall.name}#${toolCall.id} t=${performance.now().toFixed(0)}`);
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
      debugLog(`[dispatcher] streaming ABORT: closing controller t=${performance.now().toFixed(0)}`);
      try { controller.close(); } catch {}
    };
    baseCtx.signal.addEventListener('abort', onAbort, { once: true });

    void Promise.allSettled(promises).finally(() => {
      debugLog(`[dispatcher] streaming all promises settled: closing controller t=${performance.now().toFixed(0)}`);
      try { controller.close(); } catch {}
      baseCtx.signal.removeEventListener('abort', onAbort);
    });

    let reader: ReadableStreamDefaultReader<ToolEvent> | undefined;
    try {
      reader = stream.getReader();
      while (true) {
        debugLog(`[dispatcher] streaming READER waiting for next... t=${performance.now().toFixed(0)}`);
        const { done, value } = await reader.read();
        if (done) {
          debugLog(`[dispatcher] streaming READER done: t=${performance.now().toFixed(0)}`);
          break;
        }
        debugLog(`[dispatcher] streaming YIELD from reader: ${value.toolCall.name}#${value.toolCall.id} type=${value.type} t=${performance.now().toFixed(0)}`);
        yield value;
      }
    } finally {
      debugLog(`[dispatcher] streaming READER releasing lock: elapsed=${(performance.now() - streamingStart).toFixed(0)}ms`);
      if (reader) reader.releaseLock();
      await Promise.allSettled(promises);
    }
  }
}
