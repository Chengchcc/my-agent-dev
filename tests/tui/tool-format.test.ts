import { describe, test, expect } from 'bun:test';
import { formatToolCallTitle, smartSummarize, formatToolResult } from '../../src/cli/tui/utils/tool-format';

describe('formatToolCallTitle', () => {
  test('bash tool truncates long commands', () => {
    const longCmd = 'a'.repeat(200);
    const title = formatToolCallTitle({
      id: '1', name: 'bash',
      arguments: { command: longCmd },
    });
    expect(title.length).toBeLessThan(90); // 80 truncation + overhead
    expect(title).toContain('...');
  });

  test('read tool shows line range', () => {
    const title = formatToolCallTitle({
      id: '1', name: 'read',
      arguments: { path: 'src/cli/tui/hooks/use-agent-loop.tsx', start_line: 42, end_line: 68 },
    });
    expect(title).toContain('use-agent-loop.tsx');
    expect(title).toContain('lines 42-68');
  });

  test('read tool without line range shows whole file', () => {
    const title = formatToolCallTitle({
      id: '1', name: 'read',
      arguments: { path: 'package.json' },
    });
    expect(title).toContain('package.json');
    expect(title).toContain('lines 1-end');
  });

  test('grep tool truncates long patterns', () => {
    const longPattern = 'a'.repeat(100);
    const title = formatToolCallTitle({
      id: '1', name: 'grep',
      arguments: { pattern: longPattern },
    });
    expect(title.length).toBeLessThan(60);
    expect(title).toContain('...');
  });

  test('unknown tool shows first 2 params', () => {
    const title = formatToolCallTitle({
      id: '1', name: 'custom_tool',
      arguments: { foo: 'bar', baz: 'qux', extra: 'ignored' },
    });
    expect(title).toContain('custom_tool');
    expect(title).toContain('foo');
    expect(title).toContain('bar');
    expect(title).toContain('baz');
    expect(title).toContain('qux');
    expect(title).not.toContain('extra');
    expect(title).not.toContain('ignored');
  });

  test('text_editor includes path and command', () => {
    const title = formatToolCallTitle({
      id: '1', name: 'text_editor',
      arguments: { command: 'create', path: 'src/index.ts', file_text: 'hello' },
    });
    expect(title).toContain('text_editor');
    expect(title).toContain('create');
    expect(title).toContain('index.ts');
  });
});

describe('smartSummarize', () => {
  test('bash tsc no errors', () => {
    const result = smartSummarize('bash', { command: 'tsc' }, '');
    expect(result).toBe('✓ No errors');
  });

  test('bash tsc with errors counts them', () => {
    const output = 'src/a.ts:1:1 - error TS2345\nsrc/b.ts:2:2 - error TS1234';
    const result = smartSummarize('bash', { command: 'tsc' }, output);
    expect(result).toBe('✗ 2 errors');
  });

  test('bash test runner output parsing', () => {
    const output = 'Test Files  1 passed (1), 1 failed (1)';
    const result = smartSummarize('bash', { command: 'vitest' }, output);
    expect(result).toBe('✗ 1 failed, 1 passed');
  });

  test('bash empty output shows (no output)', () => {
    const result = smartSummarize('bash', { command: 'echo' }, '');
    expect(result).toBe('(no output)');
  });

  test('read tool parses JSON result with full file', () => {
    const readResult = JSON.stringify({
      path: 'src/index.ts',
      total_lines: 100,
    });
    const result = smartSummarize('read', { path: 'src/index.ts' }, readResult);
    expect(result).toContain('src/index.ts');
    expect(result).toContain('100 lines');
  });

  test('read tool parses JSON result with line range', () => {
    const readResult = JSON.stringify({
      path: 'src/index.ts',
      total_lines: 100,
      range: { start: 1, end: 50 },
    });
    const result = smartSummarize('read', { path: 'src/index.ts' }, readResult);
    expect(result).toContain('src/index.ts');
    expect(result).toContain('lines 1-50 of 100');
  });

  test('grep tool shows match count', () => {
    const grepResult = JSON.stringify({
      matches: [1, 2, 3],
      files_searched: 10,
    });
    const result = smartSummarize('grep', { pattern: 'foo' }, grepResult);
    expect(result).toContain('3 matches');
    expect(result).toContain('10 files');
  });

  test('glob tool shows file count', () => {
    const globResult = JSON.stringify({
      files: ['a.ts', 'b.ts', 'c.ts'],
      truncated: false,
    });
    const result = smartSummarize('glob', { pattern: '**/*.ts' }, globResult);
    expect(result).toBe('3 files');
  });

  test('glob tool indicates truncated results', () => {
    const globResult = JSON.stringify({
      files: Array.from({ length: 100 }, (_, i) => `f${i}.ts`),
      truncated: true,
    });
    const result = smartSummarize('glob', { pattern: '**/*' }, globResult);
    expect(result).toContain('100 files');
    expect(result).toContain('truncated');
  });

  test('ls tool shows entry count', () => {
    const lsResult = JSON.stringify({
      entries: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    });
    const result = smartSummarize('ls', { path: '.' }, lsResult);
    expect(result).toBe('3 entries');
  });

  test('text_editor create shows line count', () => {
    const result = smartSummarize('text_editor', { command: 'create', file_text: 'line1\nline2\nline3' }, '');
    expect(result).toBe('✓ Created (3 lines)');
  });

  test('text_editor view shows line count', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const result = smartSummarize('text_editor', { command: 'view' }, content);
    expect(result).toBe('(5 lines)');
  });

  test('returns null for generic cases', () => {
    // unknown tool, cannot parse JSON → returns null for default formatting
    const result = smartSummarize('unknown_tool', {}, 'some result');
    expect(result).toBeNull();
  });
});

describe('formatToolResult', () => {
  test('short result is not collapsible', () => {
    const { display, isCollapsible } = formatToolResult('ok', false, false);
    expect(display).toBe('ok');
    expect(isCollapsible).toBe(false);
  });

  test('3 lines or less is not collapsible', () => {
    const lines = 'line1\nline2\nline3';
    const { isCollapsible } = formatToolResult(lines, false, false);
    expect(isCollapsible).toBe(false);
  });

  test('more than 3 lines is collapsible when collapsed', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const { isCollapsible } = formatToolResult(lines, false, false);
    expect(isCollapsible).toBe(true);
  });

  test('long result shows head + ... + tail', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const { display, isCollapsible } = formatToolResult(lines, false, false);
    expect(isCollapsible).toBe(true);
    expect(display).toContain('line 0');
    expect(display).toContain('line 1');
    expect(display).toContain('line 2');
    expect(display).toContain('line 3');
    expect(display).toContain('line 4');
    expect(display).toContain('more lines');
    expect(display).toContain('line 47');
    expect(display).toContain('line 48');
    expect(display).toContain('line 49');
  });

  test('expanded shows everything', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const { display, isCollapsible } = formatToolResult(lines, false, true);
    expect(isCollapsible).toBe(true);
    // All lines should be present when expanded
    for (let i = 0; i < 50; i++) {
      expect(display).toContain(`line ${i}`);
    }
  });

  test('errors only collapsible if more than 10 lines', () => {
    const shortError = Array.from({ length: 5 }, (_, i) => `error ${i}`).join('\n');
    const { isCollapsible } = formatToolResult(shortError, true, false);
    expect(isCollapsible).toBe(false);

    const longError = Array.from({ length: 20 }, (_, i) => `error ${i}`).join('\n');
    const { isCollapsible: isCollapsible2 } = formatToolResult(longError, true, false);
    expect(isCollapsible2).toBe(true);
  });

  test('medium result (4-20 lines) is collapsible', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n');
    const { display, isCollapsible } = formatToolResult(lines, false, false);
    expect(isCollapsible).toBe(true);
    expect(display).toContain('... (15 lines)');
  });
});
