import { createToolSink, type ToolContext } from '../../../src/agent/tool-dispatch/types';

export function createTestCtx(overrides?: Partial<ToolContext>): ToolContext {
  const ctrl = new AbortController();
  return {
    signal: ctrl.signal,
    agentContext: { messages: [] } as any,
    budget: { remaining: 10000, usageRatio: 0 },
    environment: { agentType: 'main' as const, cwd: process.cwd() },
    metadata: new Map(),
    sink: createToolSink(),
    ...overrides,
  };
}
