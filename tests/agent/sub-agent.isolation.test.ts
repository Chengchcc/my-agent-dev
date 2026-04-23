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
    class DummyRead implements any {
      getDefinition() {
        return { name: 'read', description: 'read', parameters: { type: 'object', properties: {}, required: [] } };
      }
      async execute() { return ''; }
    }
    mainRegistry.register(new DummyRead());
    class DummyGrep implements any {
      getDefinition() { return { name: 'grep', description: 'grep', parameters: { type: 'object', properties: {}, required: [] } }; }
      async execute() { return ''; }
    }
    mainRegistry.register(new DummyGrep());

    const tool = new SubAgentTool({
      mainProvider: mockProvider,
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
    });

    // Spy on registry to see what gets filtered
    const getAllSpy = vi.spyOn(ToolRegistry.prototype, 'getAllDefinitions');
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

    getAllSpy.mockRestore();
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
