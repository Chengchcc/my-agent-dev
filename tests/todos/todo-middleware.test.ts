import { createTodoMiddleware } from '../../src/todos/todo-middleware';
import type { AgentContext } from '../../src/types';

describe('createTodoMiddleware', () => {
  it('should return a tool and middleware', () => {
    const { tool, hooks } = createTodoMiddleware();
  const middleware = hooks.beforeModel;
    expect(tool).toBeDefined();
    expect(middleware).toBeDefined();
    expect(tool.getDefinition().name).toBe('todo_write');
  });

  it('should replace todo list when merge=false', async () => {
    const { tool } = createTodoMiddleware();
    const result = await tool.execute({
      todos: [
        { id: '1', content: 'Task 1', status: 'pending' },
        { id: '2', content: 'Task 2', status: 'completed' },
      ],
      merge: false,
    });
    expect(result).toBe('Todo list updated. 2 items: 1 pending, 1 completed.');
  });

  it('should merge todos when merge=true', async () => {
    const { tool } = createTodoMiddleware();
    await tool.execute({
      todos: [
        { id: '1', content: 'Task 1', status: 'pending' },
        { id: '2', content: 'Task 2', status: 'pending' },
      ],
      merge: false,
    });
    const result = await tool.execute({
      todos: [
        { id: '1', content: 'Task 1', status: 'completed' },
        { id: '3', content: 'Task 3', status: 'in_progress' },
      ],
      merge: true,
    });
    expect(result).toBe('Todo list updated. 3 items: 1 pending, 1 in_progress, 1 completed.');
  });

  it('should inject reminder after configured steps', async () => {
    const { tool, hooks } = createTodoMiddleware();
  const middleware = hooks.beforeModel;
    await tool.execute({
      todos: [
        { id: '1', content: 'Task 1', status: 'pending' },
        { id: '2', content: 'Task 2', status: 'in_progress' },
      ],
      merge: false,
    });

    // Simulate multiple steps without tool use
    const context: AgentContext = {
      messages: [],
      config: { tokenLimit: 10000 },
      metadata: {},
      systemPrompt: '',
    };

    let calledNext = false;
    await middleware(context, async () => {
      calledNext = true;
      return context;
    });

    // First step - shouldn't remind yet
    expect(calledNext).toBe(true);
    expect(context.systemPrompt).toBe('');

    // Simulate 10 steps
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

  it('should reset counter after tool use', async () => {
    const { tool, hooks } = createTodoMiddleware();
  const middleware = hooks.beforeModel;
    await tool.execute({
      todos: [{ id: '1', content: 'Task 1', status: 'pending' }],
      merge: false,
    });

    // 9 steps without reminder
    const context: AgentContext = {
      messages: [],
      config: { tokenLimit: 10000 },
      metadata: {},
      systemPrompt: '',
    };

    for (let i = 0; i < 9; i++) {
      await middleware(context, async () => context);
    }

    // Use the tool again - resets counter
    await tool.execute({
      todos: [{ id: '1', content: 'Task 1', status: 'completed' }],
      merge: true,
    });

    // Should not have reminder yet after reset
    context.systemPrompt = '';
    await middleware(context, async () => context);
    expect(context.systemPrompt).toBe('');
  });

  it('should reset counter when last message is tool use', async () => {
    const { tool, hooks } = createTodoMiddleware();
  const middleware = hooks.beforeModel;
    await tool.execute({
      todos: [{ id: '1', content: 'Task 1', status: 'pending' }],
      merge: false,
    });

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

    // After tool use in message, counter should be reset
    await middleware(context, async () => context);

    // So we shouldn't get a reminder even after 1 step from previous
    expect(context.systemPrompt).toBe('');
  });
});
