import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { ToolCallMessage } from '../../../src/cli/tui/components/ToolCallMessage';
import type { ToolCallMessageProps } from '../../../src/cli/tui/components/ToolCallMessage';

describe('ToolCallMessage', () => {
  const renderToolCall = (props: Partial<ToolCallMessageProps>) => {
    const defaultProps: ToolCallMessageProps = {
      toolCall: { id: 'tc-1', name: 'bash', arguments: { command: 'echo hi' } },
      pending: true,
      focused: false,
      expanded: false,
      ...props,
    };
    return render(<ToolCallMessage {...defaultProps} />);
  };

  test('pending state shows tool name and command', () => {
    const { lastFrame } = renderToolCall({
      toolCall: { id: 'tc-1', name: 'bash', arguments: { command: 'echo hi' } },
      pending: true,
    });
    const frame = lastFrame();
    expect(frame).toContain('bash');
    expect(frame).toContain('echo hi');
  });

  test('completed state shows duration and summary', () => {
    const { lastFrame } = renderToolCall({
      toolCall: { id: 'tc-1', name: 'bash', arguments: { command: 'tsc' } },
      pending: false,
      focused: false,
      expanded: false,
      result: {
        content: '',
        isError: false,
        durationMs: 150,
      },
    });
    const frame = lastFrame();
    expect(frame).toContain('bash');
    expect(frame).toContain('150ms');
    expect(frame).toContain('✓ No errors');
  });

  test('error state shows error in output', () => {
    const { lastFrame } = renderToolCall({
      toolCall: { id: 'tc-1', name: 'bash', arguments: { command: 'exit 1' } },
      pending: false,
      focused: false,
      expanded: false,
      result: {
        content: 'command failed',
        isError: true,
        durationMs: 50,
      },
    });
    const frame = lastFrame();
    expect(frame).toContain('command failed');
  });

  test('focused state includes border', () => {
    const { lastFrame } = renderToolCall({
      toolCall: { id: 'tc-1', name: 'read', arguments: { path: 'test.ts' } },
      pending: false,
      focused: true,
      expanded: false,
      result: {
        content: JSON.stringify({
          path: 'test.ts',
          total_lines: 10,
          range: { start: 1, end: 10 },
          content: '// test',
        }),
        isError: false,
        durationMs: 5,
      },
    });
    const frame = lastFrame();
    // Ink renders borders with box-drawing characters
    expect(frame).toContain('│');
    expect(frame).toContain('read');
    expect(frame).toContain('test.ts');
  });

  test('read tool shows smart summary', () => {
    const { lastFrame } = renderToolCall({
      toolCall: { id: 'tc-1', name: 'read', arguments: { path: 'src/index.ts' } },
      pending: false,
      focused: false,
      expanded: false,
      result: {
        content: JSON.stringify({
          path: 'src/index.ts',
          total_lines: 100,
          range: { start: 1, end: 50 },
          content: 'line 1\nline 2',
        }),
        isError: false,
        durationMs: 12,
      },
    });
    const frame = lastFrame();
    expect(frame).toContain('src/index.ts');
    expect(frame).toContain('lines 1-50');
  });

  test('grep tool shows match count in summary', () => {
    const { lastFrame } = renderToolCall({
      toolCall: { id: 'tc-1', name: 'grep', arguments: { pattern: 'TODO' } },
      pending: false,
      focused: false,
      expanded: false,
      result: {
        content: JSON.stringify({
          matches: [{ line: 1 }, { line: 42 }],
          files_searched: 10,
        }),
        isError: false,
        durationMs: 8,
      },
    });
    const frame = lastFrame();
    expect(frame).toContain('2 matches');
    expect(frame).toContain('10 files');
  });
});
