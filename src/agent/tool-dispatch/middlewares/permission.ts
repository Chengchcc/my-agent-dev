import type { ToolMiddleware } from '../middleware';

export class PermissionMiddleware implements ToolMiddleware {
  name = 'permission';

  constructor(private rules: { denyInSubAgent: string[] }) {}

  async handle(toolCall: any, ctx: any, next: () => Promise<unknown>): Promise<unknown> {
    if (ctx.environment.agentType === 'sub_agent'
        && this.rules.denyInSubAgent.includes(toolCall.name)) {
      throw new Error(`Tool '${toolCall.name}' is not allowed in sub agent context`);
    }
    return next();
  }
}
