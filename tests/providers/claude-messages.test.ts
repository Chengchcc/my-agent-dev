import { describe, test, expect } from 'bun:test';
import { convertToClaudeMessages, extractSystemPrompt } from '../../src/providers/claude-utils';
import type { Message, ContentBlock } from '../../src/types';

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

  test('assistant with blocks containing thinking produces thinking block first', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'chain of thought', signature: 'sig1' },
      { type: 'text', text: 'The answer is 42.' },
    ];
    const messages: Message[] = [{
      role: 'assistant',
      content: 'The answer is 42.',
      blocks,
    }];

    const result = convertToClaudeMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');

    const content = result[0].content as Record<string, unknown>[];
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    // thinking must be first
    expect(content[0].type).toBe('thinking');
    expect((content[0] as Record<string, unknown>).thinking).toBe('chain of thought');
    expect((content[0] as Record<string, unknown>).signature).toBe('sig1');
    // text second
    expect(content[1].type).toBe('text');
    expect((content[1] as Record<string, unknown>).text).toBe('The answer is 42.');
  });

  test('assistant with thinking + text + tool_use blocks preserves order', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Using bash.' },
      { type: 'thinking', thinking: 'reasoning...' },
      { type: 'tool_use', id: 'tc1', name: 'bash', input: { command: 'ls' } },
    ];
    const messages: Message[] = [{
      role: 'assistant',
      content: 'Using bash.',
      blocks,
      tool_calls: [{ id: 'tc1', name: 'bash', arguments: { command: 'ls' } }],
    }];

    const result = convertToClaudeMessages(messages);
    const content = result[0].content as Record<string, unknown>[];
    expect(content).toHaveLength(3);
    // Order must be: thinking → text → tool_use (Anthropic requirement)
    expect(content[0].type).toBe('thinking');
    expect(content[1].type).toBe('text');
    expect(content[2].type).toBe('tool_use');
  });

  test('assistant with redacted_thinking block preserves it', () => {
    const blocks: ContentBlock[] = [
      { type: 'redacted_thinking', data: 'encrypted_blob' },
      { type: 'text', text: 'Response.' },
    ];
    const messages: Message[] = [{
      role: 'assistant',
      content: 'Response.',
      blocks,
    }];

    const result = convertToClaudeMessages(messages);
    const content = result[0].content as Record<string, unknown>[];
    expect(content[0].type).toBe('redacted_thinking');
    expect((content[0] as Record<string, unknown>).data).toBe('encrypted_blob');
  });

  test('legacy assistant without blocks still works (backward compat)', () => {
    const messages: Message[] = [{
      role: 'assistant',
      content: 'Plain response.',
    }];

    const result = convertToClaudeMessages(messages);
    expect(result[0].role).toBe('assistant');
    expect((result[0] as Record<string, unknown>).content).toBe('Plain response.');
  });

  test('legacy assistant with tool_calls still works (backward compat)', () => {
    const messages: Message[] = [{
      role: 'assistant',
      content: 'Check this.',
      tool_calls: [{ id: 'tc1', name: 'read', arguments: { path: '/f' } }],
    }];

    const result = convertToClaudeMessages(messages);
    const content = result[0].content as Record<string, unknown>[];
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe('text');
    expect(content[1].type).toBe('tool_use');
  });

  test('multi-turn: thinking preserved on first assistant, second turn works', () => {
    const blocks1: ContentBlock[] = [
      { type: 'thinking', thinking: 'Need to read the file.', signature: 's1' },
      { type: 'text', text: 'Reading file.' },
      { type: 'tool_use', id: 'tc1', name: 'read', input: { path: '/f' } },
    ];
    const messages: Message[] = [
      { role: 'user', content: 'Read the file.' },
      {
        role: 'assistant',
        content: 'Reading file.',
        blocks: blocks1,
        tool_calls: [{ id: 'tc1', name: 'read', arguments: { path: '/f' } }],
      },
      { role: 'tool', content: 'file contents', tool_call_id: 'tc1' },
    ];

    const result = convertToClaudeMessages(messages);
    expect(result).toHaveLength(3); // user, assistant, tool->user

    // First assistant message: thinking → text → tool_use
    const assistantMsg = result[1];
    expect(assistantMsg.role).toBe('assistant');
    const content = assistantMsg.content as Record<string, unknown>[];
    expect(content[0].type).toBe('thinking');
    expect(content[1].type).toBe('text');
    expect(content[2].type).toBe('tool_use');

    // Tool result is preserved
    const toolMsg = result[2];
    expect(toolMsg.role).toBe('user');
    const toolContent = toolMsg.content as Record<string, unknown>[];
    expect(toolContent[0].type).toBe('tool_result');
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
