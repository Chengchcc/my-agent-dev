import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { PureHeader } from '../../../src/cli/tui/components/Header';

describe('PureHeader', () => {
  test('renders logo and app name with model', () => {
    const { lastFrame } = render(<PureHeader model="claude-sonnet-4-6" sessionId={null} />);
    const frame = lastFrame();
    expect(frame).toContain('my-agent');
    expect(frame).toContain('claude-sonnet-4-6');
    expect(frame).toContain('▄█▄█▄'); // hamster logo
  });

  test('renders without model', () => {
    const { lastFrame } = render(<PureHeader model="" sessionId={null} />);
    const frame = lastFrame();
    expect(frame).toContain('my-agent');
    expect(frame).not.toContain('('); // no model parentheses
  });

  test('shows truncated session ID when provided', () => {
    const { lastFrame } = render(<PureHeader model="claude-opus-4-7" sessionId="abc123-def456-ghi789" />);
    const frame = lastFrame();
    expect(frame).toContain('session:abc123-d');
    expect(frame).not.toContain('def456'); // full ID not shown
  });
});
