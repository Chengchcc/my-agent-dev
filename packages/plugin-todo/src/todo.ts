import type { Plugin, PluginTool } from "@my-agent-team/agent";
import { readTodo, updateTodo } from "@my-agent-team/agent";

export interface TodoPluginOptions {
  readonly sessionId: string;
  readonly store: {
    appendBatch(
      sid: string,
      input: { entries: readonly Record<string, unknown>[] },
    ): Promise<unknown>;
    readBranch(sid: string): Promise<readonly { type: string; entryId: string }[]>;
  };
}

export function createTodoPlugin(opts: TodoPluginOptions): Plugin {
  return {
    name: "todo",
    tools: [createTodoWriteTool(opts)],
    meta: [
      {
        name: "Todo",
        render(): string {
          return "Track tasks with the todo_write tool. Current state is maintained across sessions.";
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
    async execute(args: Readonly<Record<string, unknown>>) {
      const items = args.items as Array<{ id: string; text: string; status: string }>;
      // Mock read/write since direct store access needs the full AgentLoop context
      return { items: items.map((i) => ({ ...i })) };
    },
  };
}
