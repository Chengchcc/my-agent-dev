import { describe, test, expect } from 'bun:test';
import { Agent, ContextManager, ToolRegistry } from '../../src/agent';
import type { Tool, ToolContext } from '../../src/types';
import { ScriptedProvider } from '../integration/agent-loop-events.test';
import { collectAgentEvents } from '../integration/test-utils';

/**
 * Tool that returns a non-string result (object), forcing JSON.stringify path.
 */
class ObjectResultTool extends ToolRegistry {
  getDefinition(): Tool {
    return {
      name: 'objectTool',
      description: 'Returns a nested object with multiple keys',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
      },
    };
  }

  async execute(_params: Record<string, unknown>, _ctx: ToolContext) {
    // Return a non-string value — triggers JSON.stringify in Agent.ts
    return { foo: 'bar', baz: 42, nested: { x: true } } as unknown as string;
  }
}

describe('tool result serialization', () => {
  test('non-string tool results are serialized as compact JSON (no indent)', async () => {
    const provider = new ScriptedProvider([
      {
        content: '',
        tool_calls: [{ id: 'tc-1', name: 'objectTool', arguments: { key: 'val' } }],
      },
      { content: 'Done' },
    ]);

    const registry = new ToolRegistry();
    registry.register(new ObjectResultTool());

    const contextManager = new ContextManager({ tokenLimit: 10000 });
    const agent = new Agent({
      provider,
      contextManager,
      config: { tokenLimit: 10000 },
      toolRegistry: registry,
    });

    const events = await collectAgentEvents(
      agent.runAgentLoop({ role: 'user', content: 'test' }),
    );

    const resultEvent = events.find(e => e.type === 'tool_call_result') as any;
    expect(resultEvent).toBeDefined();

    const content = resultEvent?.result as string;
    expect(content).toBeDefined();

    // Compact JSON should have NO newline between properties
    expect(content).not.toContain('\n');

    // Verify it's still valid JSON that contains all expected keys
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({ foo: 'bar', baz: 42, nested: { x: true } });
  });

  test('string tool results pass through unchanged', async () => {
    const provider = new ScriptedProvider([
      {
        content: '',
        tool_calls: [{ id: 'tc-2', name: 'echo', arguments: { text: 'hello' } }],
      },
      { content: 'Done' },
    ]);

    class EchoTool extends ToolRegistry {
      getDefinition(): Tool {
        return {
          name: 'echo',
          description: 'Echo tool',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        };
      }
      async execute(params: Record<string, unknown>, _ctx: ToolContext) {
        return (params as any).text as string;
      }
    }

    const registry = new ToolRegistry();
    registry.register(new EchoTool());

    const contextManager = new ContextManager({ tokenLimit: 10000 });
    const agent = new Agent({
      provider,
      contextManager,
      config: { tokenLimit: 10000 },
      toolRegistry: registry,
    });

    const events = await collectAgentEvents(
      agent.runAgentLoop({ role: 'user', content: 'test' }),
    );

    const resultEvent = events.find(e => e.type === 'tool_call_result') as any;
    expect(resultEvent).toBeDefined();
    expect(resultEvent?.result).toBe('hello');
  });
});
