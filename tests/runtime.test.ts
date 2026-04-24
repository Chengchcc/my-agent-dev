import { describe, it, expect } from 'bun:test';
import type { RuntimeConfig, AgentRuntime } from '../src/runtime';

describe('Runtime types', () => {
  it('should export RuntimeConfig and AgentRuntime types', () => {
    // Just verify the types compile (no runtime assertion needed)
    const config: RuntimeConfig = { model: 'test' };
    expect(config.model).toBe('test');
  });
});
