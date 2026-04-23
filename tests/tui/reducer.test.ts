import { describe, test, expect } from 'bun:test';
import { agentUIReducer, initialState } from '../../src/cli/tui/hooks/agent-ui-reducer';

describe('agentUIReducer', () => {
  test('SUBMIT_START sets streaming=true and records startTime', () => {
    const state = agentUIReducer(initialState, { type: 'SUBMIT_START' });
    expect(state.streaming).toBe(true);
    expect(state.streamingStartTime).toBeGreaterThan(0);
    expect(state.currentTools).toEqual([]);
  });

  test('TEXT_DELTA_BATCH updates streaming content and message id', () => {
    const msg = { id: 'stream-1', content: 'hello' };
    const state = agentUIReducer(initialState, {
      type: 'TEXT_DELTA_BATCH',
      streamingMessageId: 'stream-1',
      content: 'hello world',
    });
    expect(state.streamingContent).toBe('hello world');
    expect(state.streamingMessageId).toBe('stream-1');
  });

  test('TOOL_START updates currentTools from Map snapshot', () => {
    const toolEvent = { type: 'tool_call_start' as const, toolCall: { id: 'tc-1', name: 'bash', arguments: {} }, turnIndex: 0 };
    const map = new Map([['tc-1', toolEvent]]);
    const state = agentUIReducer(initialState, { type: 'TOOL_START', runningTools: map });
    expect(state.currentTools).toHaveLength(1);
    expect(state.currentTools[0].toolCall.id).toBe('tc-1');
  });

  test('TURN_COMPLETE accumulates usage when usage provided', () => {
    const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    const state1 = agentUIReducer(initialState, { type: 'TURN_COMPLETE', usage });
    expect(state1.totalUsage.totalTokens).toBe(150);

    const state2 = agentUIReducer(state1, { type: 'TURN_COMPLETE', usage });
    expect(state2.totalUsage.totalTokens).toBe(300);
  });

  test('TURN_COMPLETE does nothing when no usage provided', () => {
    const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    const state1 = agentUIReducer(initialState, { type: 'TURN_COMPLETE', usage });
    const state2 = agentUIReducer(state1, { type: 'TURN_COMPLETE' });
    expect(state2.totalUsage.totalTokens).toBe(150); // unchanged
  });

  test('LOOP_COMPLETE without usage does not double-count', () => {
    const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    const state1 = agentUIReducer(initialState, { type: 'TURN_COMPLETE', usage });

    // LOOP_COMPLETE without usage — should not modify totalUsage
    const state2 = agentUIReducer(state1, {
      type: 'LOOP_COMPLETE',
      messages: [],
      todos: [],
      // no usage!
    });
    expect(state2.totalUsage.totalTokens).toBe(150);
    expect(state2.streaming).toBe(false);
  });

  test('LOOP_COMPLETE with usage does NOT double-count (fixed)', () => {
    // After fix: LOOP_COMPLETE never accumulates usage
    // Usage is already handled by TURN_COMPLETE events during iteration
    const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    const state1 = agentUIReducer(initialState, { type: 'TURN_COMPLETE', usage });
    const state2 = agentUIReducer(state1, {
      type: 'LOOP_COMPLETE',
      messages: [],
      todos: [],
      usage, // same usage passed again, but it's ignored now
    });
    // Should NOT double count
    expect(state2.totalUsage.totalTokens).toBe(150);
  });

  test('LOOP_COMPLETE always sets streaming=false', () => {
    const state = agentUIReducer(initialState, { type: 'SUBMIT_START' });
    expect(state.streaming).toBe(true);

    const state2 = agentUIReducer(state, {
      type: 'LOOP_COMPLETE',
      messages: [],
      todos: [],
    });
    expect(state2.streaming).toBe(false);
    expect(state2.streamingContent).toBeNull();
  });

  test('MOVE_FOCUS with empty collapsibleTools clears focus', () => {
    const state = agentUIReducer(initialState, {
      type: 'FOCUS_TOOL',
      id: 'tc-1',
    });
    expect(state.focusedToolId).toBe('tc-1');

    const state2 = agentUIReducer(state, {
      type: 'MOVE_FOCUS',
      direction: 1,
      collapsibleTools: [],
    });
    expect(state2.focusedToolId).toBeNull();
  });

  test('MOVE_FOCUS wraps around tool list', () => {
    const state = agentUIReducer(initialState, {
      type: 'MOVE_FOCUS',
      direction: 1,
      collapsibleTools: ['tc-1', 'tc-2', 'tc-3'],
    });
    expect(state.focusedToolId).toBe('tc-1');

    // Move past last → wrap to first
    const state2 = agentUIReducer(
      { ...initialState, focusedToolId: 'tc-3' },
      { type: 'MOVE_FOCUS', direction: 1, collapsibleTools: ['tc-1', 'tc-2', 'tc-3'] },
    );
    expect(state2.focusedToolId).toBe('tc-1');

    // Move before first → wrap to last
    const state3 = agentUIReducer(
      { ...initialState, focusedToolId: 'tc-1' },
      { type: 'MOVE_FOCUS', direction: -1, collapsibleTools: ['tc-1', 'tc-2', 'tc-3'] },
    );
    expect(state3.focusedToolId).toBe('tc-3');
  });

  test('FOCUS_TOOL sets focusedToolId', () => {
    const state = agentUIReducer(initialState, { type: 'FOCUS_TOOL', id: 'tc-1' });
    expect(state.focusedToolId).toBe('tc-1');
  });

  test('TOGGLE_EXPANDED toggles focused tool', () => {
    // No focused tool → no change
    const state1 = agentUIReducer(initialState, { type: 'TOGGLE_EXPANDED' });
    expect(state1.expandedTools.size).toBe(0);

    // Focus tc-1, toggle → added
    const state2 = agentUIReducer(initialState, { type: 'FOCUS_TOOL', id: 'tc-1' });
    const state3 = agentUIReducer(state2, { type: 'TOGGLE_EXPANDED' });
    expect(state3.expandedTools.has('tc-1')).toBe(true);

    // Toggle again → removed
    const state4 = agentUIReducer(state3, { type: 'TOGGLE_EXPANDED' });
    expect(state4.expandedTools.has('tc-1')).toBe(false);
  });

  test('AGENT_ERROR adds error message to messages', () => {
    const errorMsg = { role: 'assistant' as const, content: 'Error: something broke' };
    const state = agentUIReducer(initialState, { type: 'AGENT_ERROR', errorMessage: errorMsg });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe('Error: something broke');
  });

  test('SET_TODOS replaces todos list', () => {
    const todos = [{ id: '1', text: 'Do thing', completed: false }];
    const state = agentUIReducer(initialState, { type: 'SET_TODOS', todos });
    expect(state.todos).toEqual(todos);
  });

  test('SUB_AGENT_START and SUB_AGENT_DONE update subagent maps', () => {
    const event = { agentId: 'agent-1', summary: 'Doing task', startTime: Date.now() };
    const state1 = agentUIReducer(initialState, { type: 'SUB_AGENT_START', event });
    expect(state1.runningSubAgents.has('agent-1')).toBe(true);
    expect(state1.completedSubAgents.has('agent-1')).toBe(false);

    const doneEvent = { agentId: 'agent-1', summary: 'Done', totalTurns: 5, durationMs: 1000, isError: false };
    const state2 = agentUIReducer(state1, { type: 'SUB_AGENT_DONE', event: doneEvent });
    expect(state2.runningSubAgents.has('agent-1')).toBe(false);
    expect(state2.completedSubAgents.has('agent-1')).toBe(true);
    expect(state2.completedSubAgents.get('agent-1')?.totalTurns).toBe(5);
  });
});
