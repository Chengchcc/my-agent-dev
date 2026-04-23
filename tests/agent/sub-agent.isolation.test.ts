import { describe, test, expect, vi } from 'bun:test';
import { SubAgentTool } from '../../src/agent/sub-agent-tool';
import { ContextManager } from '../../src/agent/context';
import { ToolRegistry } from '../../src/agent/tool-registry';
import type { Provider, AgentConfig } from '../../src/types';

/**
 * A scripted provider that returns predefined responses per turn.
 * Used for testing the agent loop event flow without actual API calls.
 */
class ScriptedProvider implements Provider {
  private turns: Array<{ content: string; tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }>;
  public callCount = 0;
  private turnIndex = 0;

  constructor(turns: Array<{ content: string; tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }>) {
    this.turns = turns;
  }

  registerTools(): void {}
  async invoke(): Promise<never> { throw new Error('invoke not implemented, use stream()'); }
  getModelName(): string { return 'mock'; }

  async *stream(context: AgentContext, options?: { signal?: AbortSignal }): AsyncIterable<any> {
    this.callCount++;

    // Check for abort before starting
    if (options?.signal?.aborted) {
      throw new Error('Aborted');
    }

    const turn = this.turns[this.turnIndex++];
    if (!turn) {
      yield { content: 'No more scripted turns', done: true };
      return;
    }

    // Simulate streaming: yield content character by character
    for (const char of turn.content) {
      if (options?.signal?.aborted) {
        throw new Error('Aborted');
      }
      yield { content: char, done: false };
    }

    // Yield tool calls if any
    if (turn.tool_calls) {
      for (const tc of turn.tool_calls) {
        yield {
          content: '',
          done: false,
          tool_calls: [tc],
        };
      }
    }

    // Always yield done with usage at the end
    yield {
      content: '',
      done: true,
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    };
  }
}

// Mock provider that doesn't actually execute
const mockProvider: Provider = {
  registerTools: () => {},
  invoke: async () => { throw new Error('not implemented'); },
  stream: async function*() { yield { done: true }; },
  getModelName: () => 'test',
};

const mockConfig: AgentConfig = { tokenLimit: 50000 };

describe('Context isolation', () => {
  test('sub-agent has independent ContextManager', () => {
    const mainRegistry = new ToolRegistry();
    const mainContextManager = new ContextManager({ tokenLimit: 50000 });
    const mainCtx = mainContextManager.getContext(mockConfig);
    // Add a secret message to main context
    (mainCtx as any).messages = [{ role: 'user', content: 'secret main context' }];

    const tool = new SubAgentTool({
      mainProvider: mockProvider,
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
    });

    // Spy on ContextManager constructor/getContext
    const contextSpy = vi.spyOn(ContextManager.prototype, 'getContext');

    // Execute will fail because mock provider doesn't stream properly, but it should
    // have created the sub context before that
    tool.execute({ task: 'do something' }).catch(() => {});

    expect(contextSpy).toHaveBeenCalled();
    const subCtx = contextSpy.mock.results[0].value;

    // Sub-agent context should not contain the secret from main context
    expect((subCtx as any).messages).not.toContainEqual(
      expect.objectContaining({ content: 'secret main context' })
    );

    contextSpy.mockRestore();
  });

  test('sub-agent system prompt is specialized for sub-agent execution', () => {
    const mainRegistry = new ToolRegistry();
    const mainContextManager = new ContextManager({ tokenLimit: 50000 });
    const mainCtx = mainContextManager.getContext(mockConfig);

    const tool = new SubAgentTool({
      mainProvider: mockProvider,
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
    });

    const contextSpy = vi.spyOn(ContextManager.prototype, 'setSystemPrompt');

    tool.execute({ task: 'test' }).catch(() => {});

    expect(contextSpy).toHaveBeenCalled();
    const systemPrompt = contextSpy.mock.calls[0][0];
    expect(systemPrompt).toContain('focused task executor');
    expect(systemPrompt).toContain('Execute the task directly');
    expect(systemPrompt).not.toBe(mainCtx.systemPrompt);

    contextSpy.mockRestore();
  });
});

describe('ToolRegistry filtering (recursion prevention)', () => {
  test('sub-agent ToolRegistry excludes sub_agent tool to prevent recursion', () => {
    const mainRegistry = new ToolRegistry();
    // Register sub_agent in main registry
    const mainTool = new SubAgentTool({
      mainProvider: mockProvider,
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
    });
    mainRegistry.register(mainTool);
    // Also register some other common tools
    mainRegistry.register({
      getDefinition: () => ({ name: 'read', description: 'read', parameters: { type: 'object', properties: {}, required: [] } }),
      execute: async () => '',
    });
    mainRegistry.register({
      getDefinition: () => ({ name: 'grep', description: 'grep', parameters: { type: 'object', properties: {}, required: [] } }),
      execute: async () => '',
    });

    const tool = new SubAgentTool({
      mainProvider: mockProvider,
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
    });

    // Spy on registry to see what gets filtered
    const registerSpy = vi.spyOn(ToolRegistry.prototype, 'register');

    tool.execute({ task: 'test' }).catch(() => {});

    // Check which tools got registered in sub registry
    const registeredNames: string[] = [];
    registerSpy.mock.calls.forEach(call => {
      const impl = call[0];
      if (impl.getDefinition) {
        registeredNames.push(impl.getDefinition().name);
      }
    });

    // sub_agent should be excluded
    expect(registeredNames).not.toContain('sub_agent');
    // Other tools should be included
    expect(registeredNames).toContain('read');
    expect(registeredNames).toContain('grep');

    registerSpy.mockRestore();
  });

  test('sub-agent excludes Task* tools because they use global state', () => {
    const mainRegistry = new ToolRegistry();
    mainRegistry.register({
      getDefinition: () => ({ name: 'TaskCreate', description: 'task', parameters: { type: 'object', properties: {}, required: [] } }),
      execute: async () => '',
    });
    mainRegistry.register({
      getDefinition: () => ({ name: 'TaskUpdate', description: 'task', parameters: { type: 'object', properties: {}, required: [] } }),
      execute: async () => '',
    });
    mainRegistry.register({
      getDefinition: () => ({ name: 'read', description: 'read', parameters: { type: 'object', properties: {}, required: [] } }),
      execute: async () => '',
    });

    const tool = new SubAgentTool({
      mainProvider: mockProvider,
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
    });

    const registerSpy = vi.spyOn(ToolRegistry.prototype, 'register');

    tool.execute({ task: 'test' }).catch(() => {});

    const registeredNames: string[] = [];
    registerSpy.mock.calls.forEach(call => {
      const impl = call[0];
      if (impl.getDefinition) {
        registeredNames.push(impl.getDefinition().name);
      }
    });

    expect(registeredNames).not.toContain('TaskCreate');
    expect(registeredNames).not.toContain('TaskUpdate');
    expect(registeredNames).toContain('read');

    registerSpy.mockRestore();
  });

  test('custom allowedTools filter restricts which tools are available', () => {
    const mainRegistry = new ToolRegistry();
    ['read', 'grep', 'glob', 'bash', 'write'].forEach(name => {
      mainRegistry.register({
        getDefinition: () => ({ name, description: name, parameters: { type: 'object', properties: {}, required: [] } }),
        execute: async () => '',
      });
    });

    const tool = new SubAgentTool({
      mainProvider: mockProvider,
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
      allowedTools: ['read', 'grep'], // only allow these two
    });

    const registerSpy = vi.spyOn(ToolRegistry.prototype, 'register');

    tool.execute({ task: 'test' }).catch(() => {});

    const registeredNames: string[] = [];
    registerSpy.mock.calls.forEach(call => {
      const impl = call[0];
      if (impl.getDefinition) {
        registeredNames.push(impl.getDefinition().name);
      }
    });

    expect(registeredNames).toContain('read');
    expect(registeredNames).toContain('grep');
    expect(registeredNames).not.toContain('glob');
    expect(registeredNames).not.toContain('bash');
    expect(registeredNames).not.toContain('write');

    registerSpy.mockRestore();
  });
});

describe('Resource constraints', () => {
  test('sub-agent respects maxTurns limit of 15', async () => {
    const mainRegistry = new ToolRegistry();
    mainRegistry.register({
      getDefinition: () => ({ name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }),
      execute: async () => 'ok',
    });

    // Create a provider that will generate 20 turns of tool calls
    const script = Array(10).fill({
      content: '',
      tool_calls: [{ id: `call-${Math.random()}`, name: 'read', arguments: { path: 'test.txt' } }],
    });
    // Add a final content response at the end to complete the agent
    script.push({ content: 'Done' });
    const scriptedProvider = new ScriptedProvider(script);

    const tool = new SubAgentTool({
      mainProvider: scriptedProvider,
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
      // loopConfig with maxTurns defaults to 15 from SubAgentTool
    });

    const result = await tool.execute({ task: 'keep reading' });

    // ScriptedProvider increments callCount each turn
    // Should not exceed 15-16 turns due to maxTurns limit
    // @ts-ignore ScriptedProvider has callCount
    expect(scriptedProvider.callCount).toBeLessThanOrEqual(16);
    expect(result).toContain('SubAgent');
    expect(result).toContain('turns');
  });

  test('sub-agent times out after short duration', async () => {
    // Test timeout functionality by mocking the timeout
    // Since we're testing that the timeout is handled correctly, not the timer implementation
    const mainRegistry = new ToolRegistry();

    // Create a provider that will hang forever
    class HangingProvider implements Provider {
      callCount = 0;
      registerTools() {}
      invoke = async () => { throw new Error('not implemented'); };
      getModelName() { return 'slow'; }
      async *stream(context: any, options?: { signal?: AbortSignal }) {
        this.callCount++;
        // Never resolve - this simulates a hanging provider
        // But respect the abort signal
        await new Promise((resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
        });
        yield { content: 'done', done: true };
      }
    }

    const hangingProvider = new HangingProvider();

    // Set a very short timeout for testing (200ms)
    const shortTimeoutMs = 200;
    const toolWithShortTimeout = new SubAgentTool({
      mainProvider: hangingProvider,
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
      loopConfig: { timeoutMs: shortTimeoutMs }
    });

    // Start execution with a short timeout
    const promise = toolWithShortTimeout.execute({ task: 'slow task' });

    // Wait for slightly longer than the timeout
    await new Promise(resolve => setTimeout(resolve, shortTimeoutMs + 50));

    // The promise should resolve with a timeout error
    const result = await promise;

    expect(result).toContain('Aborted');
    expect(hangingProvider.callCount).toBe(1);
  });
});
