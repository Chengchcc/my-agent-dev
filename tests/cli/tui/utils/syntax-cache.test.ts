import { describe, it, expect, beforeEach } from 'bun:test';
import { getCachedTokens, setCachedTokens } from '../../../../src/cli/tui/utils/syntax-cache';

describe('syntax-cache', () => {
  const sampleTokens: any[][] = [[{ type: 'keyword', content: 'const' }]];

  it('should return undefined for cache miss', () => {
    const result = getCachedTokens('not in cache', 'ts');
    expect(result).toBeUndefined();
  });

  it('should return cached tokens for cache hit', () => {
    setCachedTokens('my content', 'ts', sampleTokens);
    const result = getCachedTokens('my content', 'ts');
    expect(result).toBe(sampleTokens);
  });

  it('should evict oldest entry when > 50 entries', () => {
    // Add 55 entries
    for (let i = 0; i < 55; i++) {
      setCachedTokens(`content ${i}`, 'ts', [[{ type: 'text', content: `line ${i}` }]]);
    }

    // First 5 entries should be evicted
    for (let i = 0; i < 5; i++) {
      expect(getCachedTokens(`content ${i}`, 'ts')).toBeUndefined();
    }

    // Last 50 should still be there
    for (let i = 5; i < 55; i++) {
      expect(getCachedTokens(`content ${i}`, 'ts')).not.toBeUndefined();
    }
  });

  it('should treat different languages as separate cache entries', () => {
    const tokens1 = [[{ type: 'keyword', content: 'fn' }]];
    const tokens2 = [[{ type: 'keyword', content: 'def' }]];
    setCachedTokens('same content', 'rs', tokens1);
    setCachedTokens('same content', 'py', tokens2);

    expect(getCachedTokens('same content', 'rs')).toBe(tokens1);
    expect(getCachedTokens('same content', 'py')).toBe(tokens2);
  });
});
