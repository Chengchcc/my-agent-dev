import { describe, test, expect, vi } from 'bun:test';
import { SubAgentTool } from '../../src/agent/sub-agent-tool';
import { ContextManager } from '../../src/agent/context';
import { ToolRegistry } from '../../src/agent/tool-registry';
import type { Provider, AgentConfig } from '../../src/types';

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