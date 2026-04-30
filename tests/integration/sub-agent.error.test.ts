import { describe, test, expect } from 'bun:test';
import { SubAgentTool } from '../../src/agent/sub-agent-tool';
import { ToolRegistry } from '../../src/agent/tool-registry';
import type { Provider, AgentConfig } from '../../src/types';
import { createTestCtx } from '../agent/tool-dispatch/test-helpers';

const mockConfig: AgentConfig = { tokenLimit: 50000, timeoutMs: 1000 };

describe('Error handling - sub-agent failures', () => {
  test('provider throws exception → error returned as tool_result, main does not crash', async () => {
    class ErrorProvider implements Provider {
      registerTools() {}
      invoke = async () => { throw new Error('not implemented'); };
      getModelName() { return 'error'; }
      async *stream() {
        throw new Error('API rate limit exceeded');
      }
    }

    const mainRegistry = new ToolRegistry();
    const tool = new SubAgentTool({
      mainProvider: new ErrorProvider(),
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
    });

    const result = await tool.execute({ goal: 'test', deliverable: 'summary' }, createTestCtx());
    expect(result).toContain('API rate limit exceeded');
    // Doesn't throw, returns error as string so main can continue
  });

  test('sub-agent tool call fails but sub-agent handles it gracefully', async () => {
    class ErrorHandlingScriptedProvider implements Provider {
      callCount = 0;
      registerTools() {}
      invoke = async () => { throw new Error('not implemented'); };
      getModelName() { return 'scripted'; }
      async *stream() {
        this.callCount++;
        if (this.callCount === 1) {
          // First turn: call read on nonexistent file
          yield {
            content: '',
            done: false,
            tool_calls: [{
              id: 'c1',
              name: 'read',
              arguments: { path: '/nonexistent' },
            }],
          };
        } else {
          // After getting file not found error, summarize
          yield {
            content: 'File not found, skipping this file. Summary: no files found',
            done: true,
            usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
          };
        }
      }
    }

    const mainRegistry = new ToolRegistry();
    // The read tool will throw because file doesn't exist
    mainRegistry.register({
      getDefinition: () => ({
        name: 'read',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }),
      execute: async () => {
        throw new Error('File not found');
      },
    });

    const tool = new SubAgentTool({
      mainProvider: new ErrorHandlingScriptedProvider(),
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
      loopConfig: { maxTurns: 2, timeoutMs: 5000 },
    });

    const result = await tool.execute({ goal: 'read /nonexistent', deliverable: 'summary' }, createTestCtx());
    expect(result).toBeDefined();
    expect(result).toContain('File not found');
    expect(result).toContain('no files found');
    // Does not fail catastrophically
    expect(result).not.toContain('FATAL');
  });
});

describe('Abort signal propagation', () => {
  test('main agent abort → sub-agent also gets aborted', async () => {
    let started = false;
    class SlowProvider implements Provider {
      registerTools() {}
      invoke = async () => { throw new Error('not implemented'); };
      getModelName() { return 'slow'; }
      async *stream(_: any, options?: { signal?: AbortSignal }) {
        started = true;
        // Wait until aborted
        while (!options?.signal?.aborted) {
          await new Promise(r => setTimeout(r, 10));
        }
        throw new Error('Sub agent aborted by main agent');
      }
    }

    const mainRegistry = new ToolRegistry();
    const tool = new SubAgentTool({
      mainProvider: new SlowProvider(),
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
    });

    const controller = new AbortController();
    const promise = tool.execute(
      { goal: 'long task', deliverable: 'summary' },
      createTestCtx({ signal: controller.signal })
    );

    // Wait for streaming to start
    await new Promise(r => setTimeout(r, 50));
    expect(started).toBe(true);

    controller.abort();
    const result = await promise;

    expect(result).toContain('status="aborted"');
    expect(result).toContain('Sub agent aborted by main agent');
  });

  test('sub-agent completes → main abort signal remains active (not aborted)', async () => {
    class LimitedTurnProvider implements Provider {
      registerTools() {}
      invoke = async () => { throw new Error('not implemented'); };
      getModelName() { return 'limited'; }
      async *stream() {
        // We just yield content and exit naturally - hits maxTurns limit
        yield { content: 'Done with limited turns', done: true };
      }
    }

    const mainRegistry = new ToolRegistry();
    const tool = new SubAgentTool({
      mainProvider: new LimitedTurnProvider(),
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
      // Force maxTurns = 1 so it completes quickly
      loopConfig: { maxTurns: 1 },
    });

    const mainController = new AbortController();

    await tool.execute(
      { goal: 'test', deliverable: 'summary' },
      createTestCtx({ signal: mainController.signal })
    );

    // Main controller signal should still be active (not aborted)
    expect(mainController.signal.aborted).toBe(false);
  });
});
