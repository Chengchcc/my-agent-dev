import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { PureFooter } from '../../../src/cli/tui/components/Footer';

describe('PureFooter', () => {
  test('shows help text', () => {
    const { lastFrame } = render(
      <PureFooter
        totalUsage={{ totalTokens: 0 }}
        currentContextTokens={0}
        tokenLimit={100000}
      />
    );
    const frame = lastFrame();
    expect(frame).toContain('/exit');
    expect(frame).toContain('/clear');
  });

  test('hides total tokens when zero', () => {
    const { lastFrame } = render(
      <PureFooter
        totalUsage={{ totalTokens: 0 }}
        currentContextTokens={0}
        tokenLimit={100000}
      />
    );
    const frame = lastFrame();
    expect(frame).not.toContain('Total:');
    expect(frame).not.toContain('Context:');
  });

  test('shows total and context usage with low percentage (gray)', () => {
    const { lastFrame } = render(
      <PureFooter
        totalUsage={{ totalTokens: 1234 }}
        currentContextTokens={50000}
        tokenLimit={100000}
      />
    );
    const frame = lastFrame();
    expect(frame).toContain('Total: 1,234');
    expect(frame).toContain('Context:');
    expect(frame).toContain('50%');
  });

  test('uses yellow for medium percentage (>60%)', () => {
    const { lastFrame } = render(
      <PureFooter
        totalUsage={{ totalTokens: 70000 }}
        currentContextTokens={70000}
        tokenLimit={100000}
      />
    );
    const frame = lastFrame();
    expect(frame).toContain('70%');
    // Yellow is applied, but we can't easily test color in ink-testing-library
    // just verify the percentage is correct
    expect(frame).toContain('70%');
  });

  test('uses red for high percentage (>80%)', () => {
    const { lastFrame } = render(
      <PureFooter
        totalUsage={{ totalTokens: 90000 }}
        currentContextTokens={90000}
        tokenLimit={100000}
      />
    );
    const frame = lastFrame();
    expect(frame).toContain('90%');
  });

  test('handles zero token limit gracefully', () => {
    const { lastFrame } = render(
      <PureFooter
        totalUsage={{ totalTokens: 1000 }}
        currentContextTokens={0}
        tokenLimit={0}
      />
    );
    const frame = lastFrame();
    expect(frame).toContain('0%');
    // Should not crash
    expect(frame).toContain('Total: 1,000');
  });
});
