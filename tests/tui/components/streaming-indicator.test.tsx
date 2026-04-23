import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { PureStreamingIndicator } from '../../../src/cli/tui/components/StreamingIndicator';
import type { PureStreamingIndicatorProps } from '../../../src/cli/tui/components/StreamingIndicator';

describe('PureStreamingIndicator', () => {
  const renderIndicator = (props: Partial<PureStreamingIndicatorProps>) => {
    const defaultProps: PureStreamingIndicatorProps = {
      streaming: true,
      streamingStartTime: Date.now(),
      currentTools: [],
      messages: [],
      ...props,
    };
    return render(<PureStreamingIndicator {...defaultProps} />);
  };

  test('returns null when not streaming', () => {
    const { lastFrame } = renderIndicator({ streaming: false });
    expect(lastFrame()).toBe('');
  });

  test('shows "Thinking" when no tools are running', () => {
    const { lastFrame } = renderIndicator({
      streaming: true,
      currentTools: [],
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(lastFrame()).toContain('Thinking');
  });

  test('shows running tool names when tools are running', () => {
    const { lastFrame } = renderIndicator({
      streaming: true,
      currentTools: [
        { toolCall: { id: '1', name: 'bash', arguments: {} }, turnIndex: 0, type: 'tool_call_start' },
        { toolCall: { id: '2', name: 'read', arguments: {} }, turnIndex: 0, type: 'tool_call_start' },
      ],
      messages: [],
    });
    expect(lastFrame()).toContain('Running bash, read');
  });

  test('shows correct turn count', () => {
    const { lastFrame } = renderIndicator({
      streaming: true,
      currentTools: [],
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'one' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'two' },
      ],
    });
    expect(lastFrame()).toContain('Turn 2');
  });

  test('shows nextTodo when provided', () => {
    const { lastFrame } = renderIndicator({
      streaming: true,
      currentTools: [],
      messages: [],
      nextTodo: 'Write tests',
    });
    expect(lastFrame()).toContain('Next: Write tests');
  });
});
