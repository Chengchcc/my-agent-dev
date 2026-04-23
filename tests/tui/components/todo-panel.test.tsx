import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { TodoPanel } from '../../../src/cli/tui/components/TodoPanel';
import { BlinkProvider } from '../../../src/cli/tui/components/BlinkContext';

describe('TodoPanel', () => {
  test('shows "No todos" when empty', () => {
    const { lastFrame } = render(
      <BlinkProvider>
        <TodoPanel todos={[]} />
      </BlinkProvider>
    );
    expect(lastFrame()).toContain('No todos');
  });

  test('renders todos with correct status indicators', () => {
    const { lastFrame } = render(
      <BlinkProvider>
        <TodoPanel todos={[
          { id: '1', content: 'Task 1', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'in_progress' },
          { id: '3', content: 'Task 3', status: 'completed' },
          { id: '4', content: 'Task 4', status: 'cancelled' },
        ]} />
      </BlinkProvider>
    );
    const frame = lastFrame();
    expect(frame).toContain('Todo List');
    expect(frame).toContain('Task 1');
    expect(frame).toContain('Task 2');
    expect(frame).toContain('Task 3');
    expect(frame).toContain('Task 4');
    expect(frame).toContain('○'); // pending
    expect(frame).toContain('◉'); // in_progress
    expect(frame).toContain('✓'); // completed
    expect(frame).toContain('✗'); // cancelled
  });
});
