# Todo Middleware Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a todo management system with a `todo_write` tool and reminder middleware that helps agents track progress on complex multi-step tasks.

**Architecture:** Following the helixent pattern - provide a `todo_write` tool for the agent to actively manage a persistent todo list, and a `beforeModel` middleware that injects periodic reminders when the tool hasn't been used recently. The todo list persists across agent turns within the same session.

**Tech Stack:** TypeScript, Bun, existing middleware/hook architecture, Zod for validation (if needed).

---

### Task 1: Create Todo Types

**Files:**
- Create: `src/todos/types.ts`

- [ ] **Step 1: Create the file with type definitions**

```typescript
// Todo item status values
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

// Single todo item
export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}
```

- [ ] **Step 2: Add to barrel export in src/todos/index.ts**

```typescript
export * from './types';
```

- [ ] **Step 3: Compile TypeScript to verify**

Run: `bun run tsc`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/todos/types.ts src/todos/index.ts
git commit -m "feat: add todo types"
```

### Task 2: Implement Todo Middleware and Tool

**Files:**
- Create: `src/todos/todo-middleware.ts`
- Modify: `src/todos/index.ts`

- [ ] **Step 1: Write implementation**

```typescript
import type { Middleware, ToolImplementation } from '../types';
import type { TodoItem, TodoStatus } from './types';

const TODO_WRITE_TOOL_NAME = 'todo_write';

const REMINDER_CONFIG = {
  STEPS_SINCE_WRITE: 10,
  STEPS_BETWEEN_REMINDERS: 10,
} as const;

const TOOL_DESCRIPTION = `Create and manage a structured task list for the current session. This helps track progress, organize complex tasks, and demonstrate thoroughness.

## When to Use

1. Complex multi-step tasks requiring 3 or more distinct steps
2. Non-trivial tasks requiring careful planning or multiple operations
3. User explicitly requests a todo list
4. User provides multiple tasks (numbered or comma-separated)
5. After receiving new instructions — capture requirements as todos (use merge=false to add new ones)
6. After completing tasks — mark complete with merge=true and add follow-ups
7. When starting new tasks — mark as in_progress (ideally only one at a time)

## When NOT to Use

1. Single, straightforward tasks
2. Trivial tasks with no organizational benefit
3. Tasks completable in fewer than 3 trivial steps
4. Purely conversational or informational requests

## Task States

- pending: Not yet started
- in_progress: Currently working on (limit to ONE at a time)
- completed: Finished successfully
- cancelled: No longer needed

## Task Management Rules

- Update status in real-time as you work
- Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
- Only ONE task should be in_progress at any time
- Complete current tasks before starting new ones
- If blocked, keep the task as in_progress and create a new task for the blocker

## Merge Behavior

- merge=true: Merges by id — existing ids are updated, new ids are appended. You can send only the changed items.
- merge=false: Replaces the entire list with the provided todos.`;

function formatSummary(todos: TodoItem[]): string {
  const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
  for (const t of todos) counts[t.status]++;
  const parts: string[] = [];
  if (counts.pending > 0) parts.push(`${counts.pending} pending`);
  if (counts.in_progress > 0) parts.push(`${counts.in_progress} in_progress`);
  if (counts.completed > 0) parts.push(`${counts.completed} completed`);
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`);
  return `Todo list updated. ${todos.length} items: ${parts.join(", ")}.`;
}

function formatReminder(todos: TodoItem[]): string {
  const lines = todos.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n");
  return `\n<todo_reminder>
The todo_write tool hasn't been used recently. If you're working on tasks that benefit from tracking, consider updating your todo list. Only use it if relevant to the current work. Here are the current items:

${lines}
</todo_reminder>`;
}

/**
 * Creates the todo middleware system with todo_write tool and reminder injection.
 * Returns the tool implementation and the beforeModel middleware.
 */
export function createTodoMiddleware(): {
  tool: ToolImplementation;
  middleware: Middleware;
} {
  const store: TodoItem[] = [];
  let stepsSinceLastWrite = Infinity;
  let stepsSinceLastReminder = Infinity;

  const tool: ToolImplementation = {
    getDefinition(): {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    } {
      return {
        name: TODO_WRITE_TOOL_NAME,
        description: TOOL_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'Unique identifier for this todo item.',
                  },
                  content: {
                    type: 'string',
                    description: 'Description of the task.',
                  },
                  status: {
                    type: 'string',
                    enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                    description: 'Current status.',
                  },
                },
                required: ['id', 'content', 'status'],
              },
              description: 'Array of todo items to create or update.',
            },
            merge: {
              type: 'boolean',
              description:
                'If true, merges into the existing list by id (existing ids updated, new ids appended). If false, replaces the entire list.',
            },
          },
          required: ['todos', 'merge'],
        },
      };
    },

    async execute(params: Record<string, unknown>): Promise<string> {
      const todos = params.todos as TodoItem[];
      const merge = params.merge as boolean;

      if (merge) {
        for (const item of todos) {
          const idx = store.findIndex((t) => t.id === item.id);
          if (idx >= 0) {
            store[idx] = item;
          } else {
            store.push(item);
          }
        }
      } else {
        store.length = 0;
        store.push(...todos);
      }

      stepsSinceLastWrite = 0;
      return formatSummary(store);
    },
  };

  const middleware: Middleware = async (context, next) => {
    stepsSinceLastWrite++;
    stepsSinceLastReminder++;

    if (
      store.length > 0 &&
      stepsSinceLastWrite >= REMINDER_CONFIG.STEPS_SINCE_WRITE &&
      stepsSinceLastReminder >= REMINDER_CONFIG.STEPS_BETWEEN_REMINDERS
    ) {
      stepsSinceLastReminder = 0;
      if (context.systemPrompt) {
        context.systemPrompt += formatReminder(store);
      } else {
        context.systemPrompt = formatReminder(store).trim();
      }
    }

    // Check if this invocation is after a tool use of todo_write
    const lastMessage = context.messages[context.messages.length - 1];
    if (lastMessage?.role === 'tool' && lastMessage.name === TODO_WRITE_TOOL_NAME) {
      stepsSinceLastWrite = 0;
    }

    return next();
  };

  return { tool, middleware };
}
```

- [ ] **Step 2: Add export to index.ts**

Edit `src/todos/index.ts`:

```typescript
export * from './types';
export * from './todo-middleware';
```

- [ ] **Step 3: Update main entry point src/index.ts to export todos module**

Add this line to existing exports:

```typescript
export * from './todos/index';
```

- [ ] **Step 4: Compile TypeScript to verify**

Run: `bun run tsc`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/todos/todo-middleware.ts src/todos/index.ts src/index.ts
git commit -m "feat: implement todo middleware with todo_write tool"
```

### Task 3: Create Unit Tests

**Files:**
- Create: `tests/todos/todo-middleware.test.ts`

- [ ] **Step 1: Write test file**

```typescript
import { createTodoMiddleware } from '../../src/todos/todo-middleware';
import type { AgentContext } from '../../src/types';

describe('createTodoMiddleware', () => {
  it('should return a tool and middleware', () => {
    const { tool, middleware } = createTodoMiddleware();
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
    const { tool, middleware } = createTodoMiddleware();
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
    const { tool, middleware } = createTodoMiddleware();
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
    const { tool, middleware } = createTodoMiddleware();
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
```

- [ ] **Step 2: Run the test to see if it fails (should fail because no implementation)**

Run: `bun test tests/todos/todo-middleware.test.ts -v`
Expected: Tests should pass (implementation is already written)

- [ ] **Step 3: Run full test suite to ensure nothing is broken**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/todos/todo-middleware.test.ts
git commit -m "test: add unit tests for todo middleware"
```

### Task 4: Verify Compilation and All Tests

**Files:** None to modify, just verify.

- [ ] **Step 1: Run TypeScript compilation**

Run: `bun run tsc`
Expected: No compilation errors

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: All existing tests + new test pass

- [ ] **Step 3: Commit (if any fixes needed, otherwise skip)**

```bash
# Only if changes were needed
git add .
git commit -m "test: fix any issues and verify all pass"
```

