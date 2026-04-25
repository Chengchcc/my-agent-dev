import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ReadCacheMiddleware } from '../../../../src/agent/tool-dispatch/middlewares/read-cache';
import { writeFile, unlink, utimes } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ReadCacheMiddleware', () => {
  let middleware: ReadCacheMiddleware;
  let testFile: string;

  beforeEach(async () => {
    middleware = new ReadCacheMiddleware();
    testFile = join(tmpdir(), `test-read-cache-${Date.now()}.txt`);
    await writeFile(testFile, 'original content');
  });

  afterEach(async () => {
    try { await unlink(testFile); } catch {}
  });

  it('should return cached result when file mtime is unchanged', async () => {
    let callCount = 0;
    const next = async () => { callCount++; return 'file content'; };

    const toolCall = { name: 'read', arguments: { path: testFile } } as any;

    // First call - cache miss
    await middleware.handle(toolCall, {} as any, next);
    expect(callCount).toBe(1);

    // Second call - cache hit (mtime unchanged)
    await middleware.handle(toolCall, {} as any, next);
    expect(callCount).toBe(1); // Still 1 - cache worked
  });

  it('should invalidate cache when file mtime changes', async () => {
    let callCount = 0;
    const next = async () => { callCount++; return 'file content'; };

    const toolCall = { name: 'read', arguments: { path: testFile } } as any;

    // First call
    await middleware.handle(toolCall, {} as any, next);
    expect(callCount).toBe(1);

    // Modify file to change mtime
    await utimes(testFile, new Date(), new Date(Date.now() + 1000));

    // Second call - cache miss due to mtime change
    await middleware.handle(toolCall, {} as any, next);
    expect(callCount).toBe(2); // Called again - cache invalidated
  });

  it('should evict oldest entries when exceeding maxEntries', async () => {
    const files = await Promise.all(
      Array.from({ length: 105 }, async (_, i) => {
        const f = join(tmpdir(), `test-lru-${i}-${Date.now()}.txt`);
        await writeFile(f, `content ${i}`);
        return f;
      })
    );

    try {
      // Read 105 different files
      for (let i = 0; i < 105; i++) {
        const next = async () => `content ${i}`;
        const toolCall = { name: 'read', arguments: { path: files[i] } } as any;
        await middleware.handle(toolCall, {} as any, next);
      }

      // Cache should have at most 100 entries
      expect((middleware as any).cache.size).toBeLessThanOrEqual(100);
    } finally {
      await Promise.all(files.map(f => unlink(f).catch(() => {})));
    }
  });
});
