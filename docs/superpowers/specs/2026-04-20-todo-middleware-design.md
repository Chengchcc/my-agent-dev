# Todo Middleware Design

## Overview

Implement a todo management system that helps the agent track complex multi-step tasks using a combination of a tool and middleware, following the helixent pattern.

## Goals

- Help agents organize and track progress on complex multi-step tasks
- Provide a tool for the agent to actively manage its todo list
- Inject periodic reminders when todos haven't been updated recently
- Integrate with existing hook-based middleware architecture
- Maintain compatibility with existing code (no breaking changes)

## Architecture

### Types

`src/todos/types.ts`:

```typescript
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}
```

### Configuration

```typescript
const REMINDER_CONFIG = {
  STEPS_SINCE_WRITE: 10,      // Remind after 10 steps without update
  STEPS_BETWEEN_REMINDERS: 10 // Minimum steps between reminders
} as const;
```

### Main API

`src/todos/todo-middleware.ts`:

```typescript
export function createTodoMiddleware(): {
  tool: ToolImplementation;
  middleware: Middleware;
};
```

Returns:
- `tool`: The `todo_write` tool implementation
- `middleware`: Middleware that injects todo reminders, should be registered in the `beforeModel` hook

## Tool: `todo_write`

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `todos` | `TodoItem[]` | Array of todo items to create or update |
| `merge` | `boolean` | If `true`, merges by id (existing updated, new appended). If `false`, replaces the entire list |

### Description

```
Create and manage a structured task list for the current session. This helps track progress, organize complex tasks, and demonstrate thoroughness.

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
```

### Response Format

Returns a summary string with counts:
```
Todo list updated. 5 items: 2 pending, 1 in_progress, 2 completed.
```

## Middleware Behavior

Runs on the `beforeModel` hook:

1. Increments `stepsSinceLastWrite` and `stepsSinceLastReminder` counters
2. If there are todos AND `stepsSinceLastWrite >= STEPS_SINCE_WRITE` AND `stepsSinceLastReminder >= STEPS_BETWEEN_REMINDERS`:
   - Reset `stepsSinceLastReminder = 0`
   - Inject a `<todo_reminder>` section into the system prompt with all current todos listed

### Reminder Format

```
<todo_reminder>
The todo_write tool hasn't been used recently. If you're working on tasks that benefit from tracking, consider updating your todo list. Only use it if relevant to the current work. Here are the current items:

1. [in_progress] Implement todo types
2. [pending] Implement todo_write tool
3. [pending] Implement reminder middleware
4. [pending] Add unit tests
</todo_reminder>
```

## After Tool Use Detection

When the `todo_write` tool is used, reset `stepsSinceLastWrite = 0` to suppress reminders until the next period of inactivity.

## File Structure

```
src/
  todos/
    types.ts         # Type definitions
    todo-middleware.ts # Main implementation
    index.ts         # Exports
tests/
  todos/
    todo-middleware.test.ts # Unit tests
```

## Success Criteria

1. Tool correctly handles merge vs replace semantics
2. Middleware correctly injects reminders only after configured intervals
3. Todo list persists across multiple agent turns
4. Step counter resets correctly after tool use
5. All existing tests continue to pass
6. TypeScript compilation clean
