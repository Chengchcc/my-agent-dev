import type { ToolMiddleware } from '../middleware';

export class BudgetGuardMiddleware implements ToolMiddleware {
  name = 'budget-guard';

  async handle(toolCall: any, ctx: any, next: () => Promise<unknown>): Promise<unknown> {
    if (ctx.budget.usageRatio > 0.85) {
      ctx.sink.log('warn', `Budget tight (${(ctx.budget.usageRatio * 100).toFixed(0)}%), proceeding with caution`);
    }
    return next();
  }
}
