import type { AgentContext, Middleware } from '../types';

/**
 * Compose multiple middleware into a single middleware function.
 * Follows onion architecture - outer middleware runs first before, last after.
 * An empty middleware array is accepted and will just call the final handler directly.
 */
export function composeMiddlewares(
  middlewares: Middleware[],
  finalHandler: (ctx: AgentContext) => Promise<AgentContext>,
): (ctx: AgentContext) => Promise<AgentContext> {
  return async (initialContext: AgentContext): Promise<AgentContext> => {
    let index = 0;

    async function runNext(ctx: AgentContext): Promise<AgentContext> {
      if (index >= middlewares.length) {
        return finalHandler(ctx);
      }
      const middleware = middlewares[index++];

      // Guard against multiple calls to next() in the same middleware
      let called = false;
      return middleware(ctx, () => {
        if (called) {
          throw new Error('composeMiddlewares: next() called multiple times');
        }
        called = true;
        return runNext(ctx);
      });
    }

    return runNext(initialContext);
  };
}
