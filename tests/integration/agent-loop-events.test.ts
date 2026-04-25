import { describe, test, expect } from 'bun:test';
import { Agent, ContextManager, ToolRegistry } from '../../src/agent';
import type { AgentContext, LLMResponseChunk, Provider, Tool, AgentEvent, ToolContext } from '../../src/types';
import { collectAgentEvents } from './test-utils';

/**
 * A scripted provider that returns predefined responses per turn.
 * Used for testing the agent loop event flow without actual API calls.
 */
export class ScriptedProvider implements Provider {
  private turns: Array<{ content: string; tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }>;
  public callCount = 0;
  private turnIndex = 0;

  constructor(turns: Array<{ content: string; tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }>) {
    this.turns = turns;
  }

  registerTools(): void {}
  async invoke(): Promise<never> { throw new Error('invoke not implemented, use stream()'); }
  getModelName(): string { return 'mock'; }

  async *stream(context: AgentContext, options?: { signal?: AbortSignal }): AsyncIterable<LLMResponseChunk> {
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

/**
 * Simple echo tool for testing.
 */
class EchoTool extends ToolRegistry {
  getDefinition(): Tool {
    return {
      name: 'echo',
      description: 'Echo input text',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to echo' },
        },
        required: ['text'],
      },
    };
  }

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
    return `Echo: ${(params as any).text}`;
  }
}

describe('Agent Loop Event Flow (integration)', () => {
  test('simple text response yields correct event sequence', async () => {
    const provider = new ScriptedProvider([{ content: 'Hello!' }]);
    const agent = new Agent({
      provider,
      contextManager: new ContextManager({ tokenLimit: 10000 }),
      config: { tokenLimit: 10000 },
    });

    const events = await collectAgentEvents(
      agent.runAgentLoop({ role: 'user', content: 'Hi' }),
    );

    const types = events.map(e => e.type);
    // Text streaming: multiple text_delta events, then turn_complete, then agent_done
    expect(types.filter(t => t === 'text_delta')).toHaveLength(6); // "Hello!" is 6 chars
    expect(types).toContain('turn_complete');
    expect(types).toContain('agent_done');
    expect(types).not.toContain('tool_call_start');
    expect(types).not.toContain('tool_call_result');

    const done = events.find(e => e.type === 'agent_done');
    expect((done as any)?.reason).toBe('completed');
    expect((done as any)?.totalTurns).toBe(1);
  });

  test('tool call yields correct event sequence', async () => {
    const provider = new ScriptedProvider([
      {
        content: 'Let me echo that.',
        tool_calls: [{ id: 'tc-1', name: 'echo', arguments: { text: 'hello' } }],
      },
      { content: 'Done! I echoed hello.' },
    ]);

    const registry = new ToolRegistry();
    registry.register(new EchoTool());

    const agent = new Agent({
      provider,
      contextManager: new ContextManager({ tokenLimit: 10000 }),
      config: { tokenLimit: 10000 },
      toolRegistry: registry,
    });

    const events = await collectAgentEvents(
      agent.runAgentLoop({ role: 'user', content: 'Echo hello' }),
    );

    const types = events.map(e => e.type);

    // Turn 0: text_delta* → turn_complete → tool_call_start → tool_call_result
    // Turn 1: text_delta* → turn_complete → agent_done
    expect(types.filter(t => t === 'turn_complete')).toHaveLength(2);
    expect(types).toContain('tool_call_start');
    expect(types).toContain('tool_call_result');

    const toolResult = events.find(e => e.type === 'tool_call_result');
    expect((toolResult as any)?.result).toContain('Echo: hello');
    expect((toolResult as any)?.isError).toBe(false);

    const done = events.find(e => e.type === 'agent_done');
    expect((done as any)?.totalTurns).toBe(2);
    expect((done as any)?.reason).toBe('completed');
  });

  test('unknown tool returns error result and loop continues', async () => {
    const provider = new ScriptedProvider([
      {
        content: '',
        tool_calls: [{ id: 'tc-1', name: 'nonexistent', arguments: {} }],
      },
      { content: 'That tool was not found.' },
    ]);

    const agent = new Agent({
      provider,
      contextManager: new ContextManager({ tokenLimit: 10000 }),
      config: { tokenLimit: 10000 },
    });

    const events = await collectAgentEvents(
      agent.runAgentLoop({ role: 'user', content: 'test' }),
    );

    const toolResult = events.find(e => e.type === 'tool_call_result');
    expect((toolResult as any)?.result).toContain('not found');
    // Not an error that stops the loop, just an informational result
    expect((toolResult as any)?.isError).toBe(false);

    // Loop should continue to completion normally
    const done = events.find(e => e.type === 'agent_done');
    expect((done as any)?.reason).toBe('completed');
  });

  test('abort signal stops the loop immediately', async () => {
    const provider = new ScriptedProvider([
      { content: 'Starting a long task...' },
    ]);

    const agent = new Agent({
      provider,
      contextManager: new ContextManager({ tokenLimit: 10000 }),
      config: { tokenLimit: 10000 },
    });

    const abortController = new AbortController();
    // Abort immediately before starting
    abortController.abort();

    const events = await collectAgentEvents(
      agent.runAgentLoop({ role: 'user', content: 'test' }, undefined, { signal: abortController.signal }),
    );

    // When aborted before streaming starts, we still expect agent_done to be yielded with reason error
    const hasAgentDone = events.some(e => e.type === 'agent_done');
    expect(hasAgentDone).toBe(true);
  });

  test('maxTurns limit is respected', async () => {
    // Every turn calls the tool again — would loop forever without maxTurns
    const infiniteToolCalls = Array.from({ length: 10 }, () => ({
      content: 'calling echo',
      tool_calls: [{ id: `tc-${Math.random()}`, name: 'echo', arguments: { text: 'x' } }],
    }));
    const provider = new ScriptedProvider(infiniteToolCalls);

    const registry = new ToolRegistry();
    registry.register(new EchoTool());

    const agent = new Agent({
      provider,
      contextManager: new ContextManager({ tokenLimit: 10000 }),
      config: { tokenLimit: 10000 },
      toolRegistry: registry,
    });

    const events = await collectAgentEvents(
      agent.runAgentLoop({ role: 'user', content: 'test' }, { maxTurns: 3 }),
    );

    const done = events.find(e => e.type === 'agent_done');
    expect((done as any)?.reason).toBe('max_turns_reached');
    // Should not exceed maxTurns significantly
    const turnCompletes = events.filter(e => e.type === 'turn_complete').length;
    expect(turnCompletes).toBeLessThanOrEqual(4);
  });

  test('turn completes with usage accumulated correctly', async () => {
    const provider = new ScriptedProvider([{ content: 'Hello' }]);
    const agent = new Agent({
      provider,
      contextManager: new ContextManager({ tokenLimit: 10000 }),
      config: { tokenLimit: 10000 },
    });

    const events = await collectAgentEvents(
      agent.runAgentLoop({ role: 'user', content: 'Hi' }),
    );

    // turn_complete should include usage from the response
    const turnComplete = events.find(e => e.type === 'turn_complete');
    expect((turnComplete as any)?.usage).toBeDefined();
    expect((turnComplete as any)?.usage.total_tokens).toBe(70);
  });
});
