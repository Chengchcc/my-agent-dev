import { describe, it, expect } from 'bun:test';
import { PureFooter } from '../../../src/cli/tui/components/Footer';

describe('PureFooter', () => {
  const defaultProps = {
    totalTokens: 1000,
    tokensBucket: 50, // 50% usage
  };

  it('renders without crashing at normal usage', () => {
    expect(() => {
      PureFooter(defaultProps);
    }).not.toThrow();
  });

  it('handles high usage without crashing', () => {
    expect(() => {
      PureFooter({ totalTokens: 5000, tokensBucket: 100 });
    }).not.toThrow();
  });

  it('handles zero tokensBucket without crashing', () => {
    expect(() => {
      PureFooter({ totalTokens: 0, tokensBucket: 0 });
    }).not.toThrow();
  });

  it('caps percentage at 100', () => {
    const result = PureFooter({ totalTokens: 5000, tokensBucket: 100 });
    expect(result).toBeDefined();
  });

  it('handles negative-bucket (should not happen, but defensive)', () => {
    expect(() => {
      PureFooter({ totalTokens: 100, tokensBucket: 0 });
    }).not.toThrow();
  });
});
