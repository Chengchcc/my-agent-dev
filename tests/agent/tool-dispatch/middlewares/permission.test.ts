import { describe, it, expect } from 'bun:test';
import { PermissionMiddleware } from '../../../../src/agent/tool-dispatch/middlewares/permission';
import type { ToolCall } from '../../../../src/types';
import { createTestCtx } from '../test-helpers';

describe('PermissionMiddleware', () => {
  it('allows any tool in main agent', async () => {
    const mw = new PermissionMiddleware({ denyInSubAgent: ['sub_agent'] });
    const ctx = createTestCtx({ environment: { agentType: 'main', cwd: process.cwd() } });
    const tc: ToolCall = { id: '1', name: 'sub_agent', arguments: {} };

    let called = false;
    await mw.handle(tc, ctx, async () => { called = true; return 'ok'; });
    expect(called).toBe(true);
  });

  it('denies blocked tool in sub-agent', async () => {
    const mw = new PermissionMiddleware({ denyInSubAgent: ['sub_agent'] });
    const ctx = createTestCtx({ environment: { agentType: 'sub_agent', agentId: 'test', cwd: process.cwd() } });
    const tc: ToolCall = { id: '1', name: 'sub_agent', arguments: {} };

    await expect(mw.handle(tc, ctx, async () => 'should not reach')).rejects.toThrow();
  });

  it('allows non-blocked tool in sub-agent', async () => {
    const mw = new PermissionMiddleware({ denyInSubAgent: ['sub_agent'] });
    const ctx = createTestCtx({ environment: { agentType: 'sub_agent', agentId: 'test', cwd: process.cwd() } });
    const tc: ToolCall = { id: '1', name: 'bash', arguments: {} };

    let called = false;
    await mw.handle(tc, ctx, async () => { called = true; return 'ok'; });
    expect(called).toBe(true);
  });
});
