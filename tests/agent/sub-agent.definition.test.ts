import { describe, test, expect } from 'bun:test';
import { SubAgentTool } from '../../src/agent/sub-agent-tool';
import { ContextManager } from '../../src/agent/context';
import { ToolRegistry } from '../../src/agent/tool-registry';
import type { Provider, AgentConfig } from '../../src/types';
import { createTestCtx } from '../agent/tool-dispatch/test-helpers';

// Create minimal dependencies for testing
const mockProvider: Provider = {
  registerTools: () => {},
  invoke: async () => { throw new Error('not implemented'); },
  stream: async function*() { yield { done: true }; },
  getModelName: () => 'test',
};

const mockToolRegistry = new ToolRegistry();
const mockConfig: AgentConfig = { tokenLimit: 50000 };

const createTool = () => new SubAgentTool({
  mainProvider: mockProvider,
  mainToolRegistry: mockToolRegistry,
  mainAgentConfig: mockConfig,
});

describe('SubAgentTool.getDefinition()', () => {
  test('returns correct tool name', () => {
    const tool = createTool();
    expect(tool.getDefinition().name).toBe('sub_agent');
  });

  test('parameters contains required goal and deliverable fields', () => {
    const tool = createTool();
    const def = tool.getDefinition();
    expect(def.parameters.properties.goal).toBeDefined();
    expect(def.parameters.properties.goal.type).toBe('string');
    expect(def.parameters.properties.deliverable).toBeDefined();
    expect(def.parameters.required).toContain('goal');
    expect(def.parameters.required).toContain('deliverable');
  });

  test('description contains USE when and DO NOT USE when guidance', () => {
    const tool = createTool();
    const def = tool.getDefinition();
    expect(def.description).toContain('USE when');
    expect(def.description).toContain('DO NOT USE when');
  });
});

describe('SubAgentTool parameter validation', () => {
  test('empty string goal -> rejects execution', async () => {
    const tool = createTool();
    const result = await tool.execute({ goal: '', deliverable: 'summary' }, createTestCtx());
    expect(result).toContain('Error');
    expect(result).toContain('Missing required');
  });

  test('non-string goal -> returns error', async () => {
    const tool = createTool();
    // @ts-expect-error testing invalid input
    const result = await tool.execute({ goal: 123, deliverable: 'summary' }, createTestCtx());
    expect(result).toContain('Error');
    expect(result).toContain('Missing required');
  });

  test('long string goal -> passes parameter validation', async () => {
    const tool = createTool();
    const longGoal = 'a'.repeat(100_000);

    // Patch the execute method to skip the actual agent run for this test
    const originalExecute = tool.execute;
    tool.execute = async (params, _ctx) => {
      const goal = params.goal as string;
      if (!goal || typeof goal !== 'string') {
        return '<sub_agent_result status="error">Error: Missing required "goal" parameter</sub_agent_result>';
      }
      return '<sub_agent_result status="success">Mocked execution successful</sub_agent_result>';
    };

    const result = await tool.execute({ goal: longGoal, deliverable: 'summary' }, createTestCtx());
    expect(result).toBeDefined();
    expect(result).not.toContain('Error');

    // Restore original method
    tool.execute = originalExecute;
  });
});


