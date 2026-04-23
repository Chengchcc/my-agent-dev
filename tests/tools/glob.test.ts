import { GlobTool } from '../../src/tools/glob';
import { describe, expect, test, beforeAll } from 'bun:test';
import { allowedRoots } from '../../src/config/allowed-roots';

// Add test directory to allowed roots
beforeAll(() => {
  allowedRoots.push(...[__dirname]);
});

describe('GlobTool', () => {
  test('finds all test files in test directory', async () => {
    const tool = new GlobTool();
    const result = await tool.execute({
      pattern: '*.test.ts',
      path: __dirname,
    });
    expect(result).toEqual(expect.objectContaining({
      files: expect.any(Array),
      truncated: expect.any(Boolean),
    }));
    const files = (result as any).files;
    expect(files.length).toBeGreaterThan(0);
    // Should find read.test.ts and grep.test.ts
    expect(files.some((f: string) => f.includes('read.test.ts'))).toBe(true);
    expect(files.some((f: string) => f.includes('grep.test.ts'))).toBe(true);
  });

  test('respects max_results limit', async () => {
    const tool = new GlobTool();
    const result = await tool.execute({
      pattern: '**/*.ts',
      path: process.cwd() + '/src',
      max_results: 5,
    });
    const files = (result as any).files;
    expect(files.length).toBeLessThanOrEqual(5);
    expect((result as any).truncated).toBe(files.length === 5);
  });

  test('includes hidden files when asked', async () => {
    const tool = new GlobTool();
    // Search for hidden files in root
    const result = await tool.execute({
      pattern: '.*',
      path: process.cwd(),
      include_hidden: true,
    });
    const files = (result as any).files;
    // Should find at least .git or something
    expect(files.length).toBeGreaterThan(0);
  });

  test('returns empty array when no matches', async () => {
    const tool = new GlobTool();
    const result = await tool.execute({
      pattern: '*.xyzabc',
      path: __dirname,
    });
    expect((result as any).files).toEqual([]);
    expect((result as any).truncated).toBe(false);
  });
});
