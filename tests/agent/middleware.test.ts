import { describe, test, expect } from 'bun:test';
import { composeMiddlewares } from '../../src/agent/middleware';
import type { AgentContext, Middleware } from '../../src/types';

const makeContext = (): AgentContext => ({
  messages: [],
  config: { tokenLimit: 10000 },
  metadata: {},
});

describe('composeMiddlewares', () => {
  test('empty middleware array calls finalHandler directly', async () => {
    let called = false;
    const handler = composeMiddlewares([], async (ctx) => { called = true; return ctx; });
    await handler(makeContext());
    expect(called).toBe(true);
  });

  test('single middleware can modify context', async () => {
    const mw: Middleware = async (ctx, next) => {
      ctx.metadata.modified = true;
      return next();
    };
    const handler = composeMiddlewares([mw], async (ctx) => ctx);
    const result = await handler(makeContext());
    expect(result.metadata.modified).toBe(true);
  });

  test('multiple middlewares all get to call next() (regression for called-sharing bug)', async () => {
    // The bug: called was declared outside runNext, so all middlewares shared the same variable.
    // After the first middleware calls next, called becomes true, and the second middleware
    // can't call next() because it thinks it's already been called.
    const order: number[] = [];
    const mw1: Middleware = async (ctx, next) => { order.push(1); return next(); };
    const mw2: Middleware = async (ctx, next) => { order.push(2); return next(); };
    const mw3: Middleware = async (ctx, next) => { order.push(3); return next(); };

    const handler = composeMiddlewares([mw1, mw2, mw3], async (ctx) => {
      order.push(4);
      return ctx;
    });
    await handler(makeContext());
    expect(order).toEqual([1, 2, 3, 4]);
  });

  test('double-calling next() in same middleware throws', async () => {
    // Guards against misuse: same middleware can't call next twice
    const mw: Middleware = async (ctx, next) => {
      await next();
      await next(); // double call
      return ctx;
    };
    const handler = composeMiddlewares([mw], async (ctx) => ctx);
    expect(handler(makeContext())).rejects.toThrow('next() called multiple times');
  });

  test('middleware error propagates', async () => {
    const mw: Middleware = async () => { throw new Error('boom'); };
    const handler = composeMiddlewares([mw], async (ctx) => ctx);
    expect(handler(makeContext())).rejects.toThrow('boom');
  });

  test('onion architecture: outer middleware runs before and after', async () => {
    const order: string[] = [];
    const mw1: Middleware = async (ctx, next) => {
      order.push('outer before');
      const result = await next();
      order.push('outer after');
      return result;
    };
    const mw2: Middleware = async (ctx, next) => {
      order.push('inner before');
      const result = await next();
      order.push('inner after');
      return result;
    };

    const handler = composeMiddlewares([mw1, mw2], async (ctx) => {
      order.push('handler');
      return ctx;
    });
    await handler(makeContext());
    expect(order).toEqual(['outer before', 'inner before', 'handler', 'inner after', 'outer after']);
  });
});
