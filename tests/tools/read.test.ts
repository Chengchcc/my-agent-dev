import { ReadTool } from '../../src/tools/read';
import { describe, expect, test, beforeAll } from 'bun:test';
import { allowedRoots } from '../../src/config/allowed-roots';

// Add test directory to allowed roots
beforeAll(() => {
  allowedRoots.push(...[__dirname]);
});

describe('ReadTool', () => {
  test('reads entire text file', async () => {
    const tool = new ReadTool();
    const result = await tool.execute({ path: __filename });
    expect(result).toEqual(expect.objectContaining({
      path: expect.stringContaining('read.test.ts'),
      content: expect.any(String),
      total_lines: expect.any(Number),
      range: { start: 1, end: expect.any(Number) },
      truncated: false,
      size_bytes: expect.any(Number),
      language: 'typescript',
    }));
    // Content should contain this test
    expect((result as any).content).toContain('reads entire text file');
  });

  test('reads specific line range', async () => {
    const tool = new ReadTool();
    const result = await tool.execute({
      path: __filename,
      start_line: 1,
      end_line: 5,
    });
    expect((result as any).total_lines).toBeGreaterThan(5);
    expect((result as any).range.start).toBe(1);
    expect((result as any).range.end).toBe(5);
    expect((result as any).truncated).toBe(false);
    // Content should have 5 lines
    expect((result as any).content.split('\n').length).toBe(5);
  });

  test('applies max_lines limit', async () => {
    const tool = new ReadTool();
    const result = await tool.execute({
      path: __filename,
      max_lines: 10,
    });
    const lines = (result as any).content.split('\n');
    expect(lines.length).toBeLessThanOrEqual(10);
    expect((result as any).truncated).toBe(true);
  });

  test('rejects directories', async () => {
    const tool = new ReadTool();
    expect(async () => await tool.execute({ path: __dirname })).toThrow('is a directory');
  });

  test('rejects files outside allowed roots', async () => {
    const tool = new ReadTool();
    // Try to read /etc/passwd which is outside allowed roots
    expect(async () => await tool.execute({ path: '/etc/passwd' })).toThrow('not within allowed directories');
  });

  test('returns error for non-existent file', async () => {
    const tool = new ReadTool();
    expect(async () => await tool.execute({ path: './non-existent-file.test.ts' })).toThrow('Could not access file');
  });
});
