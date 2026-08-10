import type { Plugin, PluginTool, SessionStore, TodoItem } from "@my-agent-team/agent";
import { readTodo, writeTodo } from "@my-agent-team/agent";

export interface TodoPluginOptions {
  readonly sessionId: string;
  readonly store: SessionStore;
}

export function createTodoPlugin(opts: TodoPluginOptions): Plugin {
  return {
    name: "todo",
    tools: [createTodoWriteTool(opts)],
    hooks: {
      // Surface the todo snapshot as a UI-transient event right after the
      // tool runs; never written to canonical conversation history.
      afterTool(toolName: string, result: unknown, _rt: unknown) {
        if (toolName !== "todo_write") return undefined;
        const items = (result as { items?: readonly TodoItem[] } | null)?.items;
        if (!items) return undefined;
        return { type: "todo_update", items };
      },
    },
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
