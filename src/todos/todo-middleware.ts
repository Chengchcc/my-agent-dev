import type { Middleware, ToolImplementation, AgentMiddleware, AgentContext } from '../types';
import type { TodoItem, TodoStatus } from './types';
import type { ToolContext } from '../agent/tool-dispatch';

const TODO_WRITE_TOOL_NAME = 'todo_write';

const REMINDER_CONFIG = {
  STEPS_SINCE_WRITE: 10,
  STEPS_BETWEEN_REMINDERS: 10,
  STEPS_NO_IN_PROGRESS: 3,
} as const;

const TOOL_DESCRIPTION = `Create and manage a structured task list for the current session. This helps track progress, organize complex tasks, and demonstrate thoroughness.

<use_when>
- Complex multi-step tasks (3+ distinct steps)
- Non-trivial tasks requiring careful planning
- User explicitly requests a todo list
- User provides multiple tasks (numbered or comma-separated)
- After receiving new instructions — capture as todos (merge=false)
- When starting a task — mark as in_progress
- After completing a task — mark as completed IMMEDIATELY (merge=true)
</use_when>

<do_not_use>
- Single, straightforward tasks
- Trivial tasks with no organizational benefit
- Tasks completable in fewer than 3 trivial steps
- Purely conversational or informational requests
</do_not_use>

<status_values>
- pending | in_progress | completed | cancelled
</status_values>

<rules>
- Only ONE task in_progress at a time
- Mark complete IMMEDIATELY after finishing (don't batch)
- Update in real-time as you work
- Complete current tasks before starting new ones
- If blocked, keep as in_progress and create a new task for the blocker
</rules>

<merge_behavior>
- merge=true: Updates existing by id, appends new ids. Send only changed items.
- merge=false: Replaces the entire list.
</merge_behavior>`;

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

function formatReminder(reason: string, body: string): string {
  return `<system-reminder>
<todo_status reason="${reason}">
${body}
</todo_status>
</system-reminder>`;
}

function formatTodoList(todos: TodoItem[]): string {
  return todos.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n");
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

    const todos = metadata.todoStore;
    const allCompleted = todos.length > 0 &&
      todos.every(t => t.status === 'completed' || t.status === 'cancelled');
    const hasPending = todos.some(t => t.status === 'pending');
    const hasInProgress = todos.some(t => t.status === 'in_progress');

    let reminder: string | null = null;

    if (allCompleted) {
      reminder = formatReminder(
        'all_completed',
        'All todo items are marked completed or cancelled. Produce a concise summary of what was accomplished and confirm the task is done. Do NOT start new work unless the user asks.',
      );
    } else if (hasPending && !hasInProgress && metadata.stepsSinceLastWrite >= REMINDER_CONFIG.STEPS_NO_IN_PROGRESS) {
      reminder = formatReminder(
        'no_in_progress',
        `No task is marked in_progress, but the following items are pending. Mark the task you're currently working on as in_progress:\n\n${formatTodoList(todos)}`,
      );
    } else if (
      metadata.stepsSinceLastWrite >= REMINDER_CONFIG.STEPS_SINCE_WRITE &&
      metadata.stepsSinceLastReminder >= REMINDER_CONFIG.STEPS_BETWEEN_REMINDERS
    ) {
      reminder = formatReminder(
        'stale',
        `The todo_write tool hasn't been called for ${metadata.stepsSinceLastWrite} steps. Review the current list and update it if your work has progressed. Skip if not relevant.\n\nCurrent todos:\n${formatTodoList(todos)}`,
      );
    }

    if (reminder) {
      context.ephemeralReminders ??= [];
      context.ephemeralReminders.push(reminder);
      metadata.stepsSinceLastReminder = 0;
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
