import type { Middleware, ToolImplementation, AgentMiddleware, AgentContext } from '../types';
import type { TodoItem, TodoStatus } from './types';
import type { ToolContext } from '../agent/tool-dispatch';

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

- merge=true: Merges by id — existing ids are updated, new ids appended. You can send only the changed items.
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

// Extend the context metadata to store todo tracking data
export interface TodoMetadata {
  todoStore: TodoItem[];
  stepsSinceLastWrite: number;
  stepsSinceLastReminder: number;
}

/**
 * Creates the todo middleware system with todo_write tool and reminder injection.
 * Stores todo state in the agent context, so it gets cleared with agent.clear().
 * Returns the tool implementation and the beforeModel middleware.
 */
export function createTodoMiddleware(): {
  tool: ToolImplementation;
  hooks: AgentMiddleware;
} {
  // Helper to get or initialize todo metadata in context
  const getOrInitTodoMetadata = (context: AgentContext): TodoMetadata => {
    // Ensure metadata exists
    if (!context.metadata) {
      context.metadata = {};
    }
    if (!context.metadata.todo) {
      context.metadata.todo = {
        todoStore: [],
        stepsSinceLastWrite: Infinity,
        stepsSinceLastReminder: Infinity,
      } satisfies TodoMetadata;
    }
    return context.metadata.todo as TodoMetadata;
  };

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

    async execute(
      params: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<string> {
      const todos = params.todos as TodoItem[];
      const merge = params.merge as boolean;
      const metadata = getOrInitTodoMetadata(ctx.agentContext);

      // Validate todos array
      if (!Array.isArray(todos)) {
        throw new Error('todos must be an array');
      }

      // Validate each todo item
      for (const item of todos) {
        if (!item.id || !item.content || !item.status) {
          throw new Error('Each todo item must have id, content, and status properties');
        }
        if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(item.status)) {
          throw new Error(`Invalid status: ${item.status}. Must be one of pending, in_progress, completed, cancelled`);
        }
      }

      // Update todos directly in context (for middleware visibility)
      if (merge) {
        for (const item of todos) {
          const idx = metadata.todoStore.findIndex((t) => t.id === item.id);
          if (idx >= 0) {
            metadata.todoStore[idx] = item;
          } else {
            metadata.todoStore.push(item);
          }
        }
      } else {
        metadata.todoStore.length = 0;
        metadata.todoStore.push(...todos);
      }

      // Update step counters in context
      metadata.stepsSinceLastWrite = 0;
      metadata.stepsSinceLastReminder = 0;

      // Send todo updates via sink - dispatcher will sync to context manager
      ctx.sink.updateTodos(metadata.todoStore);

      return formatSummary(metadata.todoStore);
    },
  };

  const middleware: Middleware = async (context, next) => {
    const metadata = getOrInitTodoMetadata(context);
    metadata.stepsSinceLastWrite++;
    metadata.stepsSinceLastReminder++;

    // Check if all todos are completed/cancelled - add prompt to summarize
    const allCompleted = metadata.todoStore.length > 0 &&
      metadata.todoStore.every(t => t.status === 'completed' || t.status === 'cancelled');

    if (allCompleted) {
      // Add an explicit prompt to summarize completed work
      const summaryPrompt = `\n<todo_completed>
All todo items have been completed. Provide a clear summary of what you've accomplished, highlight any important results or changes made, and confirm that the task is complete.
</todo_completed>`;
      if (context.systemPrompt) {
        context.systemPrompt += summaryPrompt;
      } else {
        context.systemPrompt = summaryPrompt.trim();
      }
    } else if (
      metadata.stepsSinceLastWrite >= REMINDER_CONFIG.STEPS_SINCE_WRITE &&
      metadata.stepsSinceLastReminder >= REMINDER_CONFIG.STEPS_BETWEEN_REMINDERS
    ) {
      metadata.stepsSinceLastReminder = 0;
      if (context.systemPrompt) {
        context.systemPrompt += formatReminder(metadata.todoStore);
      } else {
        context.systemPrompt = formatReminder(metadata.todoStore).trim();
      }
    }

    return next();
  };

  return {
    tool,
    hooks: {
      beforeModel: middleware,
    },
  };
}
