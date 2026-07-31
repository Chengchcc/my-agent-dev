import type { Plugin, PluginTool, SessionStore } from "@my-agent-team/agent";
import { readTodo, writeTodo } from "@my-agent-team/agent";

export interface TodoPluginOptions {
  readonly sessionId: string;
  readonly store: SessionStore;
}

export function createTodoPlugin(opts: TodoPluginOptions): Plugin {
  return {
    name: "todo",
    tools: [createTodoWriteTool(opts)],
    meta: [
      {
        name: "Todo",
        render(): string {
          return "Use todo_write to track tasks. State persists across sessions.";
        },
      },
    ],
  };
}

function createTodoWriteTool(opts: TodoPluginOptions): PluginTool {
  return {
    name: "todo_write",
    description: "Update the task list. Provide the full desired state.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "done", "cancelled"] },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["items"],
    },
    async execute(
      args: Readonly<Record<string, unknown>>,
    ): Promise<Readonly<Record<string, unknown>>> {
      const items = args.items as Array<{ id: string; text: string; status: string }>;
      await writeTodo(opts.store, opts.sessionId, {
        items: items.map((i) => ({
          id: i.id,
          text: i.text,
          status: i.status as "pending" | "in_progress" | "done" | "cancelled",
        })),
      });
      return { items } as unknown as Readonly<Record<string, unknown>>;
    },
  };
}

export function createTodoReadTool(opts: TodoPluginOptions): PluginTool {
  return {
    name: "todo_read",
    description: "Read the current task list.",
    inputSchema: { type: "object", properties: {} },
    async execute(): Promise<Readonly<Record<string, unknown>>> {
      const state = await readTodo(opts.store, opts.sessionId);
      return { items: state.items } as unknown as Readonly<Record<string, unknown>>;
    },
  };
}
