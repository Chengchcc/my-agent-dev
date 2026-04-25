import { GrepTool } from '../../src/tools/grep';
import { describe, expect, test, beforeAll } from 'bun:test';
import { allowedRoots } from '../../src/config/allowed-roots';
import { createTestCtx } from '../agent/tool-dispatch/test-helpers';

// Add test directory to allowed roots
beforeAll(() => {
  allowedRoots.push(...[__dirname]);
});

describe('GrepTool', () => {
  test('searches for pattern in test files', async () => {
    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: 'ReadTool',
      path: __dirname,
    }, createTestCtx());
    expect(result).toEqual(expect.objectContaining({
      matches: expect.any(Array),
      files_searched: expect.any(Number),
    }));
    // Should find ReadTool in read.test.ts
    const matches = (result as any).matches;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m: any) => m.file.includes('read.test.ts'))).toBe(true);
  });

  test('filters by include pattern', async () => {
    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: 'test',
      path: __dirname,
      include: '*.test.ts',
    }, createTestCtx());
    expect((result as any).matches.length).toBeGreaterThan(0);
  });

  test('excludes node_modules directories when searching', async () => {
    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: 'test',
      path: process.cwd(),
      max_results: 1000,
    }, createTestCtx());
    // node_modules should not be searched deeply - total files searched won't
    // exceed the project files (which are much less than node_modules total)
    expect((result as any).files_searched).toBeLessThan(2000);
  });

  test('returns zero matches when no results', async () => {
    const tool = new GrepTool();
    // Generate a random pattern that can't exist in any file
    const pattern = Buffer.from([1, 2, 3, 4, 5, 255, 254, 253, 252]).toString('base64');
    const result = await tool.execute({ pattern, path: __dirname }, createTestCtx());
    expect(result).toEqual(expect.objectContaining({
      total_matches: 0,
      files_searched: expect.any(Number),
    }));
    expect((result as any).matches).toHaveLength(0);
  });

  test('handles glob-style include patterns', async () => {
    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: 'test',
      path: __dirname,
      include: '*.ts',
    }, createTestCtx());
    expect((result as any).matches.length).toBeGreaterThan(0);
  });
});
