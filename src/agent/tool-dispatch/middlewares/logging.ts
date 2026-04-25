import type { ToolMiddleware } from '../middleware';

export class LoggingMiddleware implements ToolMiddleware {
  name = 'logging';

  async handle(toolCall: any, ctx: any, next: () => Promise<unknown>): Promise<unknown> {
    const start = Date.now();
    ctx.sink.log('debug', `[${toolCall.name}] start`);
    try {
      const result = await next();
      ctx.sink.log('info', `[${toolCall.name}] done in ${Date.now() - start}ms`);
      return result;
    } catch (error) {
      ctx.sink.log('warn', `[${toolCall.name}] failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}
