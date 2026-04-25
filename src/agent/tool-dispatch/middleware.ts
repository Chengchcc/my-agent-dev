import type { ToolCall } from '../../types';
import type { ToolContext } from './types';

/**
 * ToolMiddleware — 拦截单个 tool 执行的中间件
 * 洋葱模型：handle 调用 next() 前的代码先执行，next() 返回后的代码后执行
 */
export interface ToolMiddleware {
  /** Middleware 名称（用于调试） */
  name: string;

  /**
   * 拦截 tool 执行
   */
  handle(
    toolCall: ToolCall,
    ctx: ToolContext,
    next: () => Promise<unknown>,
  ): Promise<unknown>;
}
