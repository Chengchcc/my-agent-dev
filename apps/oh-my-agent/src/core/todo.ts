import type { Plugin, PluginTool, SessionStore, TodoItem } from "@chengchenccc/agent";
import { readTodo, writeTodo } from "@chengchenccc/agent";

export interface TodoPluginOptions {
  readonly sessionId: string;
  readonly store: SessionStore;
}

function isTodoItemShape(value: unknown): value is { id: string; text: string; status: string } {
  if (typeof value !== "object" || value === null) return false;
  return (
    "id" in value &&
    typeof value.id === "string" &&
    "text" in value &&
    typeof value.text === "string" &&
    "status" in value &&
    typeof value.status === "string"
  );
}

function toTodoItem(item: { id: string; text: string; status: string }): TodoItem {
  const status = item.status;
  if (
    status !== "pending" &&
    status !== "in_progress" &&
    status !== "done" &&
    status !== "cancelled"
  ) {
    return { id: item.id, text: item.text, status: "pending" };
  }
  return { id: item.id, text: item.text, status };
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
      const rawItems = args.items;
      if (!Array.isArray(rawItems)) return { error: "items must be an array" };
      const typed = rawItems.filter(isTodoItemShape);
      const items = typed.map(toTodoItem);
      await writeTodo(opts.store, opts.sessionId, { items });
      return { items };
    },
  };
}

export function createTodo(opts: TodoPluginOptions): Plugin {
  return {
    name: "todo",
    tools: [createTodoWriteTool(opts)],
    hooks: {
      afterTool(toolName: string, result: unknown) {
        if (toolName !== "todo_write") return undefined;
        if (typeof result !== "object" || result === null) return undefined;
        if (!("items" in result) || !Array.isArray(result.items)) return undefined;
        const items = result.items.filter(isTodoItemShape).map(toTodoItem);
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

export function createTodoReadTool(opts: TodoPluginOptions): PluginTool {
  return {
    name: "todo_read",
    description: "Read the current task list.",
    inputSchema: { type: "object", properties: {} },
    async execute(): Promise<Readonly<Record<string, unknown>>> {
      const state = await readTodo(opts.store, opts.sessionId);
      return { items: state.items };
    },
  };
}
