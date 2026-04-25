import { describe, test, expect, spyOn } from 'bun:test';
import { Agent, ContextManager, ToolRegistry } from '../../src/agent';
import type { Tool } from '../../src/types';
import { ScriptedProvider } from '../integration/agent-loop-events.test';
import { collectAgentEvents } from '../integration/test-utils';

class ErrorTool extends ToolRegistry {
  getDefinition(): Tool {
    return {
      name: 'errorTool',
      description: 'Always throws an error',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    };
  }

  async execute(): Promise<string> {
    throw new Error('Intentional test error');
  }
}

describe('toolErrorStrategy = "halt"', () => {
  test('when tool errors: throws error, no addMessage, no tool_call_result event', async () => {
    const provider = new ScriptedProvider([
      {
        content: '',
        tool_calls: [{ id: 'tc-1', name: 'errorTool', arguments: {} }],
      },
    ]);

    const registry = new ToolRegistry();
    registry.register(new ErrorTool());

    const contextManager = new ContextManager({ tokenLimit: 10000 });
    const addMessageSpy = spyOn(contextManager, 'addMessage');

    const agent = new Agent({
      provider,
      contextManager,
      config: {
        tokenLimit: 10000,
      },
      toolRegistry: registry,
    });

    // Error is caught by agent loop and yielded as agent_error + agent_done events
    let caughtError: Error | null = null;
    let events: any[] = [];

    try {
      events = await collectAgentEvents(
        agent.runAgentLoop({ role: 'user', content: 'test' }, { toolErrorStrategy: 'halt' }),
      );
    } catch (e) {
      caughtError = e as Error;
    }

    // 1. Error does NOT bubble up from generator (caught internally and converted to events)
    expect(caughtError).toBeNull();

    // 2. But agent_error and agent_done events ARE yielded with the error
    const agentErrorEvents = events.filter(e => e.type === 'agent_error');
    expect(agentErrorEvents).toHaveLength(1);
    expect(agentErrorEvents[0].error.message).toContain('Intentional test error');

    const agentDoneEvents = events.filter(e => e.type === 'agent_done');
    expect(agentDoneEvents).toHaveLength(1);
    expect(agentDoneEvents[0].reason).toBe('error');
    expect(agentDoneEvents[0].error.message).toContain('Intentional test error');

    // 3. addMessage was NOT called for the tool result (no side effect before throw)
    // (addMessage is called for user message + assistant response = 2 normal calls)
    const toolResultAddMessages = addMessageSpy.mock.calls.filter(
      (call: any) => call[0]?.role === 'tool',
    );
    expect(toolResultAddMessages).toHaveLength(0);

    // 4. tool_call_result event was NOT yielded (no side effect before throw)
    const toolResultEvents = events.filter(e => e.type === 'tool_call_result');
    expect(toolResultEvents).toHaveLength(0);
  });

  test('when tool succeeds: no throw, normal side effects occur', async () => {
    const provider = new ScriptedProvider([
      {
        content: '',
        tool_calls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello' } }],
      },
      { content: 'Done' },
    ]);

    class EchoTool extends ToolRegistry {
      getDefinition(): Tool {
        return {
          name: 'echo',
          description: 'Echo',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        };
      }
      async execute(params: { text: string }) {
        return params.text;
      }
    }

    const registry = new ToolRegistry();
    registry.register(new EchoTool());

    const contextManager = new ContextManager({ tokenLimit: 10000 });
    const addMessageSpy = spyOn(contextManager, 'addMessage');

    const agent = new Agent({
      provider,
      contextManager,
      config: {
        tokenLimit: 10000,
      },
      toolRegistry: registry,
    });

    let caughtError: Error | null = null;
    let events: any[] = [];

    try {
      events = await collectAgentEvents(
        agent.runAgentLoop({ role: 'user', content: 'test' }, { toolErrorStrategy: 'halt' }),
      );
    } catch (e) {
      caughtError = e as Error;
    }

    // 1. No error thrown for successful tool execution
    expect(caughtError).toBeNull();

    // 2. addMessage WAS called
    expect(addMessageSpy).toHaveBeenCalled();

    // 3. tool_call_result event WAS yielded
    const toolResultEvents = events.filter(e => e.type === 'tool_call_result');
    expect(toolResultEvents).toHaveLength(1);
  });
});
