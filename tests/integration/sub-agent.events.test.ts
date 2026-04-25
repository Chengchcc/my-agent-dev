import { describe, test, expect, vi } from 'bun:test';
import { Agent, ContextManager, ToolRegistry } from '../../src/agent';
import { SubAgentTool } from '../../src/agent/sub-agent-tool';
import type { Provider, AgentConfig, AgentEvent } from '../../src/types';
import { collectAgentEvents } from './test-utils';
import { ScriptedProvider } from './agent-loop-events.test';

const mockConfig: AgentConfig = { tokenLimit: 50000 };

function createDualProviderSetup(
  mainScript: Array<{ content: string; tool_calls?: Array<any> }>,
  subScript: Array<{ content: string; tool_calls?: Array<any> }>
) {
  const mainProvider = new ScriptedProvider(mainScript);
  const subProvider = new ScriptedProvider(subScript);

  const mainRegistry = new ToolRegistry();
  const subAgentTool = new SubAgentTool({
    mainProvider: subProvider,
    mainToolRegistry: mainRegistry,
    mainAgentConfig: mockConfig,
  });
  mainRegistry.register(subAgentTool);

  // Add read tool for sub-agent to call
  mainRegistry.register({
    getDefinition: () => ({
      name: 'read',
      description: 'read file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }),
    execute: async () => '// test file content\nhello world',
  });

  const mainAgent = new Agent({
    provider: mainProvider,
    contextManager: new ContextManager({ tokenLimit: 50000 }),
    config: mockConfig,
    toolRegistry: mainRegistry,
  });

  return { mainAgent, mainProvider, subProvider, subAgentTool };
}

describe('Event bubbling sequence (integration)', () => {
  test('events bubble in correct order: sub_agent_start → sub_agent_event* → sub_agent_done', async () => {
    const { mainAgent, subAgentTool } = createDualProviderSetup(
      // Main agent script: call sub_agent, then output final summary
      [
        {
          content: '',
          tool_calls: [{
            id: 'call_1',
            name: 'sub_agent',
            arguments: { task: 'summarize src/' },
          }],
        },
        { content: 'Here is the summary from the sub-agent.' },
      ],
      // Sub-agent script: read a file, then give summary
      [
        {
          content: '',
          tool_calls: [{
            id: 'sub_1',
            name: 'read',
            arguments: { path: 'src/index.ts' },
          }],
        },
        { content: 'The file contains the main entry point.' },
      ]
    );

    // Track events from the sub-agent tool
    const events: AgentEvent[] = [];
    subAgentTool['config'].onEvent = (agentId: string, event: AgentEvent) => {
      events.push(event);
    };

    await collectAgentEvents(
      mainAgent.runAgentLoop({ role: 'user', content: 'summarize the project' })
    );

    const eventTypes = events.map(e => e.type);
    const subStart = eventTypes.findIndex(t => t === 'sub_agent_start');
    const subDone = eventTypes.findIndex(t => t === 'sub_agent_done');

    expect(subStart).toBeGreaterThan(-1);
    expect(subDone).toBeGreaterThan(subStart);

    // All sub_agent_event must be between start and done
    const subEvents = events.filter(e => e.type === 'sub_agent_event');
    subEvents.forEach(e => {
      const idx = events.indexOf(e);
      expect(idx).toBeGreaterThan(subStart);
      expect(idx).toBeLessThan(subDone);
    });
  });

  test('sub-agent internal text_delta events bubble through sub_agent_event', async () => {
    const { mainAgent, subAgentTool } = createDualProviderSetup(
      [
        {
          content: '',
          tool_calls: [{
            id: 'call_1',
            name: 'sub_agent',
            arguments: { task: 'say hello' },
          }],
        },
      ],
      [
        { content: 'Hello from sub agent' },
      ]
    );

    // Track events from the sub-agent tool
    const events: AgentEvent[] = [];
    subAgentTool['config'].onEvent = (agentId: string, event: AgentEvent) => {
      events.push(event);
    };

    await collectAgentEvents(
      mainAgent.runAgentLoop({ role: 'user', content: 'test' })
    );

    const subTextEvents = events.filter(
      e => e.type === 'sub_agent_event' && (e as any).event?.type === 'text_delta'
    );
    expect(subTextEvents.length).toBeGreaterThan(0);
    // Should carry the actual text
    const hasText = subTextEvents.some(e => (e as any).event?.delta);
    expect(hasText).toBe(true);
  });

  test('sub-agent tool_use events bubble through sub_agent_event', async () => {
    const { mainAgent, subAgentTool } = createDualProviderSetup(
      [
        {
          content: '',
          tool_calls: [{
            id: 'call_1',
            name: 'sub_agent',
            arguments: { task: 'read a file' },
          }],
        },
        { content: 'Done reading' },
      ],
      [
        {
          content: '',
          tool_calls: [{ id: 'sub_1', name: 'read', arguments: { path: 'test.txt' } }],
        },
        { content: 'File content is: hello' },
      ]
    );

    // Track events from the sub-agent tool
    const events: AgentEvent[] = [];
    subAgentTool['config'].onEvent = (agentId: string, event: AgentEvent) => {
      events.push(event);
    };

    await collectAgentEvents(
      mainAgent.runAgentLoop({ role: 'user', content: 'test' })
    );

    const subToolEvents = events.filter(
      e => e.type === 'sub_agent_event' && (e as any).event?.type === 'tool_call_start'
    );
    expect(subToolEvents.length).toBeGreaterThan(0);
  });
});

describe('Return value integration', () => {
  test('sub-agent final output is returned as tool_result to main agent', async () => {
    const { mainAgent } = createDualProviderSetup(
      [
        {
          content: '',
          tool_calls: [{
            id: 'call_1',
            name: 'sub_agent',
            arguments: { task: 'summarize' },
          }],
        },
      ],
      [
        { content: 'The summary is: main entry point at src/index.ts' },
      ]
    );

    const events = await collectAgentEvents(
      mainAgent.runAgentLoop({ role: 'user', content: 'summarize' })
    );

    // Find the tool_result for sub_agent call
    const toolResultEvent = events.find(
      e => e.type === 'tool_call_result' && (e as any).toolCall.name === 'sub_agent'
    );
    expect(toolResultEvent).toBeDefined();
    expect((toolResultEvent as any).result).toContain('main entry point');
    expect((toolResultEvent as any).isError).toBe(false);
  });

  test('sub-agent returns formatted summary string, not raw JSON messages', async () => {
    const mainRegistry = new ToolRegistry();
    const subProvider = new ScriptedProvider([
      { content: 'Final summary from sub agent.' },
    ]);
    const tool = new SubAgentTool({
      mainProvider: subProvider,
      mainToolRegistry: mainRegistry,
      mainAgentConfig: mockConfig,
    });

    const result = await tool.execute({ task: 'test' }, {
      signal: new AbortController().signal,
      environment: { agentType: 'main' },
      sink: { log: () => {} },
    });
    expect(typeof result).toBe('string');
    expect(result).toContain('[SubAgent');
    expect(result).toContain('completed');
    expect(result).toContain('Final summary');
    // Should not be a JSON array of messages
    expect(result).not.toMatch(/^\[\s*\{/);
  });
});
