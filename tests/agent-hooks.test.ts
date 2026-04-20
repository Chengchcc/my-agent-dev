import { Agent, ContextManager, type AgentContext, type Middleware } from '../src';
import { describe, expect, test } from 'bun:test';

// Mock provider that just returns a fixed response
class MockProvider {
  async invoke(context: AgentContext) {
    return {
      content: 'mock response',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      model: 'mock',
    };
  }
  registerTools() {}
  async* stream() {
    yield { content: 'mock', done: true };
  }
}

describe('Agent Hooks', () => {
  test('hooks execute in correct order', async () => {
    const calls: string[] = [];

    const hook1: Middleware = async (ctx, next) => {
      calls.push('beforeAgentRun');
      return next();
    };
    const hook2: Middleware = async (ctx, next) => {
      calls.push('beforeCompress');
      return next();
    };
    const hook3: Middleware = async (ctx, next) => {
      calls.push('beforeModel');
      return next();
    };
    const hook4: Middleware = async (ctx, next) => {
      calls.push('afterModel');
      return next();
    };
    const hook5: Middleware = async (ctx, next) => {
      calls.push('beforeAddResponse');
      return next();
    };
    const hook6: Middleware = async (ctx, next) => {
      calls.push('afterAgentRun');
      return next();
    };

    const contextManager = new ContextManager({ tokenLimit: 10000 });
    const agent = new Agent({
      provider: new MockProvider(),
      contextManager,
      hooks: {
        beforeAgentRun: [hook1],
        beforeCompress: [hook2],
        beforeModel: [hook3],
        afterModel: [hook4],
        beforeAddResponse: [hook5],
        afterAgentRun: [hook6],
      },
      config: { tokenLimit: 10000 },
    });

    await agent.run({ role: 'user', content: 'test' });

    expect(calls).toEqual([
      'beforeAgentRun',
      'beforeCompress',
      'beforeModel',
      'afterModel',
      'beforeAddResponse',
      'afterAgentRun',
    ]);
  });

  test('hooks can modify context before model', async () => {
    let modifiedMetadata = false;

    const hook: Middleware = async (ctx, next) => {
      ctx.metadata.testKey = 'testValue';
      modifiedMetadata = true;
      return next();
    };

    const contextManager = new ContextManager({ tokenLimit: 10000 });
    const agent = new Agent({
      provider: new MockProvider(),
      contextManager,
      hooks: { beforeModel: [hook] },
      config: { tokenLimit: 10000 },
    });

    const result = await agent.run({ role: 'user', content: 'test' });

    expect(modifiedMetadata).toBe(true);
    expect(result.metadata.testKey).toBe('testValue');
  });
});
