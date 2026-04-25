import { createTodoMiddleware } from '../../src/todos/todo-middleware';
import type { AgentContext } from '../../src/types';
import { createTestCtx } from '../agent/tool-dispatch/test-helpers';

describe('createTodoMiddleware', () => {
  test('should return a tool and middleware', () => {
    const { tool, hooks } = createTodoMiddleware();
    const middleware = hooks.beforeModel;
    expect(tool).toBeDefined();
    expect(middleware).toBeDefined();
    expect(tool.getDefinition().name).toBe('todo_write');
  });

  test('should replace todo list when merge=false', async () => {
    const { tool } = createTodoMiddleware();
    const context: AgentContext = {
      messages: [],
      config: { tokenLimit: 10000 },
      metadata: {},
    };
    const result = await tool.execute({
      todos: [
        { id: '1', content: 'Task 1', status: 'pending' },
        { id: '2', content: 'Task 2', status: 'completed' },
      ],
      merge: false,
    }, createTestCtx({ agentContext: context }));
    expect(result).toBe('Todo list updated. 2 items: 1 pending, 1 completed.');
  });

  test('should merge todos when merge=true', async () => {
    const { tool } = createTodoMiddleware();
    const context: AgentContext = {
      messages: [],
      config: { tokenLimit: 10000 },
      metadata: {},
    };
    await tool.execute({
      todos: [
        { id: '1', content: 'Task 1', status: 'pending' },
        { id: '2', content: 'Task 2', status: 'pending' },
      ],
      merge: false,
    }, createTestCtx({ agentContext: context }));
    const result = await tool.execute({
      todos: [
        { id: '1', content: 'Task 1', status: 'completed' },
        { id: '3', content: 'Task 3', status: 'in_progress' },
      ],
      merge: true,
    }, createTestCtx({ agentContext: context }));
    expect(result).toBe('Todo list updated. 3 items: 1 pending, 1 in_progress, 1 completed.');
  });

  test('should inject reminder after configured steps', async () => {
    const { tool, hooks } = createTodoMiddleware();
    const middleware = hooks.beforeModel;
    const context: AgentContext = {
      messages: [],
      config: { tokenLimit: 10000 },
      metadata: {},
      systemPrompt: '',
    };
    await tool.execute({
      todos: [
        { id: '1', content: 'Task 1', status: 'pending' },
        { id: '2', content: 'Task 2', status: 'in_progress' },
      ],
      merge: false,
    }, createTestCtx({ agentContext: context }));

    // Simulate multiple steps without tool use
    let calledNext = false;
    await middleware(context, async () => {
      calledNext = true;
      return context;
    });

    // First step - shouldn't remind yet
    expect(calledNext).toBe(true);
    expect(context.systemPrompt).toBe('');

    // Simulate 9 more steps = 10 total steps since last write
    for (let i = 0; i < 9; i++) {
      calledNext = false;
      await middleware(context, async () => {
        calledNext = true;
        return context;
      });
      expect(calledNext).toBe(true);
    }

    // After 10 steps total, should have reminder
    expect(context.systemPrompt).toContain('<todo_reminder>');
    expect(context.systemPrompt).toContain('[pending] Task 1');
    expect(context.systemPrompt).toContain('[in_progress] Task 2');
    expect(context.systemPrompt).toContain('todo_write tool hasn\'t been used recently');
  });

  test('should reset counter after tool use', async () => {
    const { tool, hooks } = createTodoMiddleware();
    const middleware = hooks.beforeModel;
    const context: AgentContext = {
      messages: [],
      config: { tokenLimit: 10000 },
      metadata: {},
      systemPrompt: '',
    };
    await tool.execute({
      todos: [{ id: '1', content: 'Task 1', status: 'pending' }],
      merge: false,
    }, createTestCtx({ agentContext: context }));

    // 9 steps without reminder
    for (let i = 0; i < 9; i++) {
      await middleware(context, async () => context);
    }

    // Use the tool again - resets counter
    await tool.execute({
      todos: [{ id: '1', content: 'Task 1', status: 'completed' }],
      merge: true,
    }, createTestCtx({ agentContext: context }));

    // Should not have reminder yet after reset
    // But since all todos are completed, should inject todo_completed prompt
    context.systemPrompt = '';
    await middleware(context, async () => context);
    expect(context.systemPrompt).toContain('<todo_completed>');
    expect(context.systemPrompt).toContain('All todo items have been completed');
  });

  test('should reset counter when last message is tool use', async () => {
    const { tool, hooks } = createTodoMiddleware();
    const middleware = hooks.beforeModel;
    const context: AgentContext = {
      messages: [
        {
          role: 'tool',
          content: 'Todo list updated...',
          name: 'todo_write',
          tool_call_id: 'test',
        },
      ],
      config: { tokenLimit: 10000 },
      metadata: {},
      systemPrompt: '',
    };
    await tool.execute({
      todos: [{ id: '1', content: 'Task 1', status: 'pending' }],
      merge: false,
    }, createTestCtx({ agentContext: context }));

    // After tool use in message, counter should be reset
    await middleware(context, async () => context);

    // So we shouldn't get a reminder even after 1 step from previous
    expect(context.systemPrompt).toBe('');
  });
});
