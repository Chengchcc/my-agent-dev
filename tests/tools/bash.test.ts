import { BashTool } from '../../src/tools';
import { describe, expect, test } from 'bun:test';
import { createTestCtx } from '../agent/tool-dispatch/test-helpers';

describe('BashTool', () => {
  test('executes successful command', async () => {
    const tool = new BashTool();
    const result = await tool.execute({ command: 'echo "hello world"' }, createTestCtx());
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('hello world');
    expect(result.timedOut).toBe(false);
  });

  test('captures stderr', async () => {
    const tool = new BashTool();
    const result = await tool.execute({ command: '>&2 echo "error message"' }, createTestCtx());
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('error message');
  });

  test('handles non-zero exit code', async () => {
    const tool = new BashTool();
    const result = await tool.execute({ command: 'exit 1' }, createTestCtx());
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
  });

  test('times out long-running command', async () => {
    const tool = new BashTool({ timeoutMs: 100 });
    const result = await tool.execute({ command: 'sleep 1' }, createTestCtx());
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });
});
