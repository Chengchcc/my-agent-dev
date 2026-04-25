import type { ToolMiddleware } from '../middleware';
import type { ToolCall } from '../../../types';
import type { ToolContext } from '../types';
import { stat } from 'fs/promises';

export class ReadCacheMiddleware implements ToolMiddleware {
  name = 'read-cache';
  private cache = new Map<string, { result: unknown; mtimeMs: number }>();
  private maxEntries = 100;

  async handle(toolCall: ToolCall, _ctx: ToolContext, next: () => Promise<unknown>): Promise<unknown> {
    if (toolCall.name !== 'read') return next();

    const path = toolCall.arguments.path as string;
    const startLine = (toolCall.arguments.start_line as number | undefined) ?? '';
    const endLine = (toolCall.arguments.end_line as number | undefined) ?? '';
    const key = `read:${path}:${startLine}:${endLine}`;

    const cached = this.cache.get(key);
    try {
      const fileStat = await stat(path);
      if (cached && cached.mtimeMs === fileStat.mtimeMs) {
        // LRU: move to end
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached.result;
      }
    } catch {
      // stat failed (file doesn't exist) - skip cache
    }

    const result = await next();

    // LRU eviction
    if (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }

    // Cache with mtime
    try {
      const fileStat = await stat(path);
      this.cache.set(key, { result, mtimeMs: fileStat.mtimeMs });
    } catch {
      // stat failed - don't cache
    }

    return result;
  }

  /** Clear cache manually (for testing) */
  clear(): void {
    this.cache.clear();
  }
}
