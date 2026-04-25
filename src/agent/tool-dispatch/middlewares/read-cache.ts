import type { ToolMiddleware } from '../middleware';

export class ReadCacheMiddleware implements ToolMiddleware {
  name = 'read-cache';
  private cache = new Map<string, { result: unknown; timestamp: number }>();
  private ttlMs = 30_000;

  async handle(toolCall: any, _ctx: any, next: () => Promise<unknown>): Promise<unknown> {
    if (toolCall.name !== 'read') return next();

    const path = toolCall.arguments.path;
    const startLine = toolCall.arguments.start_line ?? '';
    const endLine = toolCall.arguments.end_line ?? '';
    const key = `read:${path}:${startLine}:${endLine}`;

    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.ttlMs) {
      return cached.result;
    }

    const result = await next();
    this.cache.set(key, { result, timestamp: Date.now() });
    return result;
  }

  /** Clear cache manually (for testing) */
  clear(): void {
    this.cache.clear();
  }
}
