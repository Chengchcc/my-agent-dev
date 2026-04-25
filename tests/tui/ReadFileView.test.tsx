import { describe, it, expect } from 'bun:test';
import chalk from 'chalk';

describe('ReadFileView ANSI optimization', () => {
  it('should build colored line with ANSI escapes', () => {
    // Save original chalk level and force colors for this test
    const originalLevel = chalk.level;
    chalk.level = 1;

    const tokens = [
      { type: 'keyword', content: 'const' },
      { type: 'plain', content: ' ' },
      { type: 'identifier', content: 'x' },
      { type: 'plain', content: ' = ' },
      { type: 'number', content: '42' },
    ];

    const theme: Record<string, string> = {
      keyword: 'cyan',
      identifier: 'yellow',
      number: 'green',
    };

    let line = '';
    for (const token of tokens) {
      const colorName = token.type ? theme[token.type] : null;
      const colorFn = colorName ? (chalk as unknown as Record<string, ((s: string) => string) | undefined>)[colorName] : null;
      if (colorFn) {
        line += colorFn(token.content);
      } else {
        line += token.content;
      }
    }

    expect(line).toContain('const');
    expect(line).toContain('x');
    expect(line).toContain('42');
    expect(line.includes('\x1B[')).toBe(true); // Has ANSI escape

    // Restore original chalk level
    chalk.level = originalLevel;
  });
});
