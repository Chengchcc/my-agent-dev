import type { AgentContext, Middleware } from './types';

/**
 * Compose multiple middleware into a single middleware function.
 * Follows onion architecture - outer middleware runs first before, last after.
 * An empty middleware array is accepted and will just call the final handler directly.
 */
export function composeMiddlewares(
  middlewares: Middleware[],
  finalHandler: (context: AgentContext) => Promise<AgentContext>
): (context: AgentContext) => Promise<AgentContext> {
  return async (context: AgentContext): Promise<AgentContext> => {
    let index = 0;

    async function runNext(): Promise<AgentContext> {
      if (index >= middlewares.length) {
        return finalHandler(context);
      }
      const middleware = middlewares[index++];
      return middleware(context, runNext);
    }

    return runNext();
  };
}
