import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { PureChatMessage } from '../../../src/cli/tui/components/ChatMessage';
import type { Message } from '../../../../src/types';

describe('PureChatMessage', () => {
  test('renders user message with cyan color and > prefix', () => {
    const message: Message = {
      role: 'user',
      content: 'Hello world',
    };

    const { lastFrame } = render(<PureChatMessage message={message} />);
    const frame = lastFrame();
    expect(frame).toContain('> user:');
    expect(frame).toContain('Hello world');
  });

  test('renders assistant message with white color and < prefix', () => {
    const message: Message = {
      role: 'assistant',
      content: 'Hi there',
    };

    const { lastFrame } = render(<PureChatMessage message={message} />);
    const frame = lastFrame();
    expect(frame).toContain('< assistant:');
    expect(frame).toContain('Hi there');
  });

  test('returns null for tool messages (rendered inline by assistant)', () => {
    const message: Message = {
      role: 'tool',
      content: 'result',
      tool_call_id: 'tc-1',
    };

    const { lastFrame } = render(<PureChatMessage message={message} />);
    expect(lastFrame()).toBe('');
  });

  test('returns null for system messages (not shown in chat UI)', () => {
    const message: Message = {
      role: 'system',
      content: 'System instruction',
    };

    const { lastFrame } = render(<PureChatMessage message={message} />);
    expect(lastFrame()).toBe('');
  });

  test('renders assistant message with code block', () => {
    const message: Message = {
      role: 'assistant',
      content: 'Here is some code:\n```ts\nconsole.log("hello");\n```',
    };

    const { lastFrame } = render(<PureChatMessage message={message} />);
    const frame = lastFrame();
    expect(frame).toContain('console.log');
  });

  test('renders assistant message with tool calls', () => {
    const message: Message = {
      role: 'assistant',
      content: 'Let me run a command',
      tool_calls: [{ id: 'tc-1', name: 'bash', arguments: { command: 'echo hello' } }],
    };

    const { lastFrame } = render(<PureChatMessage message={message} />);
    const frame = lastFrame();
    expect(frame).toContain('Let me run a command');
    expect(frame).toContain('bash');
  });
});
