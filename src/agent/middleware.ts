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
    let called = false;

    async function runNext(ctx: AgentContext): Promise<AgentContext> {
      // Guard against multiple calls to next() in the same middleware
      if (called) {
        throw new Error('composeMiddlewares: next() called multiple times');
      }
      called = true;

      if (index >= middlewares.length) {
        return finalHandler(ctx);
      }
      const middleware = middlewares[index++];
      return middleware(ctx, () => runNext(ctx));
    }

    return runNext(initialContext);
  };
}
