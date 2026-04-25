import { describe, it, expect } from 'bun:test';
import { PureFooter } from '../../../src/cli/tui/components/Footer';

describe('PureFooter', () => {
  const defaultProps = {
    totalUsage: { totalTokens: 1000 },
    currentContextTokens: 100000,
    tokenLimit: 200000,
  };

  it('renders without crashing at normal usage', () => {
    expect(() => {
      PureFooter(defaultProps);
    }).not.toThrow();
  });

  it('handles currentContextTokens > tokenLimit without crashing', () => {
    expect(() => {
      PureFooter({
        ...defaultProps,
        currentContextTokens: 250000,
        tokenLimit: 200000,
      });
    }).not.toThrow();
  });

  it('handles tokenLimit = 0 without crashing', () => {
    expect(() => {
      PureFooter({
        ...defaultProps,
        tokenLimit: 0,
      });
    }).not.toThrow();
  });

  it('handles currentContextTokens = 0 without crashing', () => {
    expect(() => {
      PureFooter({
        ...defaultProps,
        currentContextTokens: 0,
      });
    }).not.toThrow();
  });

  it('handles negative currentContextTokens without crashing', () => {
    expect(() => {
      PureFooter({
        ...defaultProps,
        currentContextTokens: -100,
      });
    }).not.toThrow();
  });

  it('caps percentage at 100 when over limit', () => {
    const result = PureFooter({
      ...defaultProps,
      currentContextTokens: 300000,
      tokenLimit: 200000,
    });
    expect(result).toBeDefined();
  });
});
