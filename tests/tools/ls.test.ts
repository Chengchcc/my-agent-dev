import { LsTool } from '../../src/tools/ls';
import { describe, expect, test, beforeAll } from 'bun:test';
import { allowedRoots } from '../../src/config/allowed-roots';
import { createTestCtx } from '../agent/tool-dispatch/test-helpers';

// Add test directory to allowed roots
beforeAll(() => {
  allowedRoots.push(...[__dirname]);
});

describe('LsTool', () => {
  test('lists directory contents', async () => {
    const tool = new LsTool();
    const result = await tool.execute({ path: __dirname }, createTestCtx());
    expect(result).toEqual(expect.objectContaining({
      entries: expect.any(Array),
    }));
    const entries = (result as any).entries;
    expect(entries.length).toBeGreaterThan(0);
    // Should have at least the test files we just created
    expect(entries.some((e: any) => e.name === 'read.test.ts')).toBe(true);
    expect(entries.some((e: any) => e.name === 'grep.test.ts')).toBe(true);
    // Each entry should have path, type, size, modified
    entries.forEach((e: any) => {
      expect(e.name).toBeDefined();
      expect(e.path).toBeDefined();
      expect(e.type).toBeDefined();
      expect(e.size).toBeDefined();
      expect(e.modified).toBeDefined();
    });
  });

  test('handles non-existent directory', async () => {
    const tool = new LsTool();
    expect(async () => await tool.execute({ path: './non-existent-directory' }, createTestCtx())).toThrow();
  });

  test('works on current directory', async () => {
    const tool = new LsTool();
    const result = await tool.execute({ path: '.' }, createTestCtx());
    expect((result as any).entries.length).toBeGreaterThan(0);
  });
});
