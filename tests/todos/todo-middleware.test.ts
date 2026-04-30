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
    expect(context.ephemeralReminders).toBeUndefined();

    // Simulate 9 more steps = 10 total steps since last write
    for (let i = 0; i < 9; i++) {
      calledNext = false;
      await middleware(context, async () => {
        calledNext = true;
        return context;
      });
      expect(calledNext).toBe(true);
    }

    // After 10 steps total, should have reminder in ephemeralReminders
    expect(context.ephemeralReminders).toBeDefined();
    expect(context.ephemeralReminders!.length).toBeGreaterThan(0);
    const reminder = context.ephemeralReminders![0]!;
    expect(reminder).toContain('<system-reminder>');
    expect(reminder).toContain('<todo_status reason="stale"');
    expect(reminder).toContain('[pending] Task 1');
    expect(reminder).toContain('[in_progress] Task 2');
  });

  test('should inject all_completed reminder when all done', async () => {
    const { tool, hooks } = createTodoMiddleware();
    const middleware = hooks.beforeModel;
    const context: AgentContext = {
      messages: [],
      config: { tokenLimit: 10000 },
      metadata: {},
    };
    await tool.execute({
      todos: [{ id: '1', content: 'Task 1', status: 'completed' }],
      merge: false,
    }, createTestCtx({ agentContext: context }));

    // All completed — should inject all_completed reminder immediately
    await middleware(context, async () => context);
    expect(context.ephemeralReminders).toBeDefined();
    const reminder = context.ephemeralReminders![0]!;
    expect(reminder).toContain('<todo_status reason="all_completed"');
    expect(reminder).toContain('All todo items are marked completed');
  });

  test('should inject no_in_progress reminder when pending tasks lack in_progress', async () => {
    const { tool, hooks } = createTodoMiddleware();
    const middleware = hooks.beforeModel;
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

    // 3 steps without any task marked in_progress — should trigger no_in_progress
    for (let i = 0; i < 3; i++) {
      await middleware(context, async () => context);
    }
    expect(context.ephemeralReminders).toBeDefined();
    const reminder = context.ephemeralReminders![0]!;
    expect(reminder).toContain('<todo_status reason="no_in_progress"');
    expect(reminder).toContain('No task is marked in_progress');
  });

  test('should reset counter after tool use', async () => {
    const { tool, hooks } = createTodoMiddleware();
    const middleware = hooks.beforeModel;
    const context: AgentContext = {
      messages: [],
      config: { tokenLimit: 10000 },
      metadata: {},
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

    // After reset, the all_completed reminder fires (not stale)
    delete context.ephemeralReminders;
    await middleware(context, async () => context);
    expect(context.ephemeralReminders).toBeDefined();
    const reminder = context.ephemeralReminders![0]!;
    expect(reminder).toContain('<todo_status reason="all_completed"');
  });
});
