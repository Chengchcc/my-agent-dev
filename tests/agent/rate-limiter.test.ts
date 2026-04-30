import { describe, test, expect } from 'bun:test';
import { TokenBucket, RateLimitedProvider } from '../../src/agent/rate-limiter';
import type { Provider, AgentContext, LLMResponse, LLMResponseChunk } from '../../src/types';

describe('TokenBucket', () => {
  test('initial tokens are available immediately', async () => {
    const bucket = new TokenBucket(3, 5);
    const start = Date.now();
    await bucket.acquire();
    expect(Date.now() - start).toBeLessThan(10);
  });

  test('refills tokens over time', async () => {
    const bucket = new TokenBucket(1, 10); // 1 burst, 10/sec refill
    await bucket.acquire(); // consume the burst token
    // Next acquire should wait ~100ms for a token to refill
    const start = Date.now();
    await bucket.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(50); // at least some wait
    expect(elapsed).toBeLessThan(300); // but not too long
  });

  test('multiple acquires respect rate', async () => {
    const bucket = new TokenBucket(2, 20); // 2 burst, 20/sec
    // First two should be instant (burst)
    const start = Date.now();
    await bucket.acquire();
    await bucket.acquire();
    // Third should wait ~50ms
    await bucket.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(elapsed).toBeLessThan(200);
  });
});

describe('RateLimitedProvider', () => {
  class MockProvider implements Provider {
    callCount = 0;
    registerTools() {}
    getModelName() { return 'mock'; }
    async invoke(_ctx: AgentContext): Promise<LLMResponse> {
      this.callCount++;
      return { content: 'ok', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    }
    async *stream(_ctx: AgentContext, _opts?: { signal?: AbortSignal }): AsyncIterable<LLMResponseChunk> {
      this.callCount++;
      yield { content: 'ok', done: true, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    }
  }

  test('passes through provider methods', () => {
    const mock = new MockProvider();
    const wrapped = new RateLimitedProvider(mock, { prefix: 'test' });
    expect(wrapped.getModelName()).toBe('mock');
  });

  test('rate limits concurrent calls', async () => {
    const mock = new MockProvider();
    const wrapped = new RateLimitedProvider(mock, { requestsPerSecond: 10, maxConcurrent: 1 });

    const start = Date.now();
    const results = await Promise.all([
      wrapped.invoke({} as AgentContext),
      wrapped.invoke({} as AgentContext),
      wrapped.invoke({} as AgentContext),
    ]);

    const elapsed = Date.now() - start;
    // 3 calls with burst=1, RPS=10 → at least 2 refill waits of ~100ms each
    expect(results.length).toBe(3);
    expect(mock.callCount).toBe(3);
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(600);
  });

  test('prefix is used in provider (no crash)', async () => {
    const mock = new MockProvider();
    const wrapped = new RateLimitedProvider(mock, { prefix: 'test-agent-1' });
    const result = await wrapped.invoke({} as AgentContext);
    expect(result.content).toBe('ok');
  });
});
