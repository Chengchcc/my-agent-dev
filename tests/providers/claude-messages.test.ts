import { describe, test, expect } from 'bun:test';
import { convertToClaudeMessages, extractSystemPrompt } from '../../src/providers/claude-utils';
import type { Message } from '../../src/types';

describe('convertToClaudeMessages', () => {
  test('assistant with tool_calls produces content array with tool_use blocks', () => {
    const messages: Message[] = [{
      role: 'assistant',
      content: 'Let me check that.',
      tool_calls: [{ id: 'tc-1', name: 'bash', arguments: { command: 'ls' } }],
    }];

    const result = convertToClaudeMessages(messages);
    const assistantMsg = result[0];
    expect(result).toHaveLength(1);
    expect(assistantMsg.role).toBe('assistant');
    expect(Array.isArray(assistantMsg.content)).toBe(true);

    const content = assistantMsg.content as any[];
    expect(content[0].type).toBe('text');
    expect(content[0].text).toBe('Let me check that.');
    expect(content[1].type).toBe('tool_use');
    expect(content[1].id).toBe('tc-1');
    expect(content[1].name).toBe('bash');
  });

  test('tool message becomes user message with tool_result', () => {
    const messages: Message[] = [{
      role: 'tool',
      content: 'output',
      tool_call_id: 'tc-1',
    }];

    const result = convertToClaudeMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');

    const content = (result[0] as any).content as any[];
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe('tool_result');
    expect(content[0].tool_use_id).toBe('tc-1');
    expect(content[0].content).toBe('output');
  });

  test('system messages are filtered out', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
    ];

    const result = convertToClaudeMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect((result[0] as any).content).toBe('Hello');
  });

  test('multiple messages with mixed roles are converted correctly', () => {
    const messages: Message[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'First question' },
      {
        role: 'assistant',
        content: 'Let me use bash',
        tool_calls: [{ id: 'tc-1', name: 'bash', arguments: { command: 'date' } }],
      },
      { role: 'tool', content: 'Mon Apr 22 10:00:00 2026', tool_call_id: 'tc-1' },
      { role: 'assistant', content: 'Done! The date is today.' },
    ];

    const result = convertToClaudeMessages(messages);
    // system is filtered out → 4 messages remain
    expect(result).toHaveLength(4);

    // Check tool result conversion
    const toolMsg = result[2];
    expect(toolMsg.role).toBe('user');
    expect(Array.isArray((toolMsg as any).content)).toBe(true);
  });

  test('plain user and plain assistant messages work', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];

    const result = convertToClaudeMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect((result[0] as any).content).toBe('Hello');
    expect(result[1].role).toBe('assistant');
    expect((result[1] as any).content).toBe('Hi there!');
  });

  test('assistant with multiple tool calls converts all', () => {
    const messages: Message[] = [{
      role: 'assistant',
      content: 'I will call two tools',
      tool_calls: [
        { id: 'tc-1', name: 'read', arguments: { path: 'a.txt' } },
        { id: 'tc-2', name: 'grep', arguments: { pattern: 'foo' } },
      ],
    }];

    const result = convertToClaudeMessages(messages);
    expect(result).toHaveLength(1);
    const content = (result[0] as any).content as any[];
    expect(content).toHaveLength(3); // text + two tool uses
    expect(content[1].type).toBe('tool_use');
    expect(content[1].id).toBe('tc-1');
    expect(content[2].type).toBe('tool_use');
    expect(content[2].id).toBe('tc-2');
  });
});

describe('extractSystemPrompt', () => {
  test('extracts system messages joined with newlines', () => {
    const messages: Message[] = [
      { role: 'system', content: 'First system line' },
      { role: 'user', content: 'Hello' },
      { role: 'system', content: 'Second system line' },
    ];

    const result = extractSystemPrompt(messages);
    expect(result).toBe('First system line\nSecond system line');
  });

  test('returns empty string when no system messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];

    const result = extractSystemPrompt(messages);
    expect(result).toBe('');
  });
});
