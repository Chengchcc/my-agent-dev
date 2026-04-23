import { describe, test, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { BlinkingText } from '../../../src/cli/tui/components/BlinkingText';
import { BlinkProvider } from '../../../src/cli/tui/components/BlinkContext';

describe('BlinkingText', () => {
  test('renders children with normal color when visible', () => {
    const { lastFrame } = render(
      <BlinkProvider blinkingOn={true}>
        <BlinkingText>Hello</BlinkingText>
      </BlinkProvider>
    );
    expect(lastFrame()).toBe('Hello');
  });
});
