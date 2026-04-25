import type { AgentContext, ToolCall } from '../../types';
import type { TodoItem } from '../../todos/types';

/**
 * ToolSink — tool 的副作用输出通道（收集式）。
 * Tool 执行过程中调用这些方法收集数据，Dispatcher 在 tool 完成后统一处理。
 */
export interface ToolSink {
  /** 报告 todo 状态变更 */
  updateTodos(todos: TodoItem[]): void;

  readonly _todoUpdates: TodoItem[] | undefined;
}

/**
 * ToolContext — 统一的工具执行上下文 */
export interface ToolContext {
  /** Abort signal — 来自 agent loop 或用户取消 */
  signal: AbortSignal;

  /** 当前 agent 上下文的只读快照 */
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

/**
 * ToolExecutionResult — 单个 tool 的执行结果
 */
export interface ToolExecutionResult {
  /** Tool 返回的原始内容（string 类型会经过截断处理，其他类型原样返回） */
  content: unknown;
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

/**
 * ToolEvent — Dispatcher 产出的事件流
 */
export type ToolEvent =
  | { type: 'tool:start'; toolCall: ToolCall; index: number }
  | { type: 'tool:result'; toolCall: ToolCall; result: ToolExecutionResult };

/**
 * DispatchOptions — 调度选项
 */
export interface DispatchOptions {
  /** 并行执行 tool calls */
  parallel: boolean;
  /** 边完成边 yield — false = 全部完成后批量 yield */
  yieldAsCompleted: boolean;
  /** 单个 tool 超时 ms */
  toolTimeoutMs: number;
  /** 输出截断阈值 */
  maxOutputChars: number;
}

/**
 * 创建 ToolSink 实例的工厂函数
 */
export function createToolSink(): ToolSink {
  const state: {
    _todoUpdates: TodoItem[] | undefined;
  } = {
    _todoUpdates: undefined,
  };

  return {
    updateTodos(todos: TodoItem[]) {
      state._todoUpdates = todos;
    },
    get _todoUpdates() {
      return state._todoUpdates;
    },
  };
}
