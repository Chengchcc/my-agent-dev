import { defineContext, definePlugin, type Plugin } from "@my-agent-team/agent";
import type { Tool } from "@my-agent-team/core";

/** Context key for todo progress. Plugin writes, metaContext reads. */
export const TodoKey = defineContext<string>("todo-progress");
// ─── Types ───

export type TodoStatus = "pending" | "in_progress" | "done" | "cancelled";

export interface Todo {
  step: string;
  status: TodoStatus;
}

export interface TodoPluginOptions {
  /** Inject todo progress into system prompt each turn. Default true. */
  showProgress?: boolean;
}

// ─── Helpers ───

function renderTodo(list: readonly Todo[]): string {
  if (list.length === 0) return "(empty plan)";
  return list
    .map((t) => {
      const mark =
        t.status === "done"
          ? "x"
          : t.status === "in_progress"
            ? ">"
            : t.status === "cancelled"
              ? "-"
              : " ";
      return `- [${mark}] ${t.step}`;
    })
    .join("\n");
}

// ─── todo_write tool ───

type TodoAction =
  | { action: "add"; steps: string[] }
  | { action: "update"; updates: Array<{ step: string; status: TodoStatus }> }
  | { action: "move"; step: string; direction: "up" | "down" }
  | { action: "delete"; steps: string[] };

function createTodoWriteTool(opts: {
  getTodos: (sessionId: string) => Todo[] | undefined;
  setTodos: (sessionId: string, todos: Todo[]) => void;
  getActiveSessionId: () => string;
  onUpdate: (todos: Todo[]) => void;
}): Tool {
  return {
    name: "todo_write",
    description:
      "Creates or updates the assistant's visible todo list for tracking multi-step work. " +
      "Only use for non-trivial tasks with several concrete steps where tracking progress helps the user - " +
      "skip it for single-step or trivial requests, where it just adds overhead. " +
      "Only one step should be in_progress at a time. " +
      "Actions: add (new steps), update (change status), move (reorder), delete (remove steps).",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["add", "update", "move", "delete"],
          description: "The operation to perform on the todo list.",
        },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "Step descriptions (for add) or step names (for delete).",
        },
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "done", "cancelled"] },
            },
            required: ["step", "status"],
          },
          description: "Status updates (for update action).",
        },
        step: { type: "string", description: "Step to move (for move action)." },
        direction: {
          type: "string",
          enum: ["up", "down"],
          description: "Direction to move (for move action).",
        },
      },
      required: ["action"],
    },
    execute: (input: unknown) => {
      const args = input as TodoAction;
      const tid = opts.getActiveSessionId();
      let list = opts.getTodos(tid);
      if (!list) {
        // Auto-create empty list on first use
        list = [];
        opts.setTodos(tid, list);
      }

      switch (args.action) {
        case "add": {
          for (const step of args.steps) {
            if (!list.some((t) => t.step === step)) {
              list.push({ step, status: "pending" });
            }
          }
          break;
        }
        case "update": {
          for (const u of args.updates) {
            const t = list.find((x) => x.step === u.step);
            if (t) t.status = u.status;
          }
          break;
        }
        case "move": {
          const idx = list.findIndex((x) => x.step === args.step);
          if (idx < 0) break;
          const swap = args.direction === "up" ? idx - 1 : idx + 1;
          if (swap < 0 || swap >= list.length) break;
          [list[idx], list[swap]] = [list[swap]!, list[idx]!];
          break;
        }
        case "delete": {
          const toDelete = new Set(args.steps);
          opts.setTodos(
            tid,
            list.filter((t) => !toDelete.has(t.step)),
          );
          list = opts.getTodos(tid)!;
          break;
        }
      }

      opts.onUpdate([...list]);
      return { content: renderTodo(list) };
    },
  };
}

// ─── Plugin factory ───

/**
 * Todo plugin: track task progress via todo_write tool + inject progress into system prompt.
 *
 * - beforeModel: injects the current todo progress into the system prompt.
 * - todo_write tool: model adds steps, updates status, reorders, or deletes steps.
 *
 * Plan generation and stop-gate validation live in plugin-task-guard / plugin-goal.
 */
export function todoPlugin(opts?: TodoPluginOptions): Plugin {
  const showProgress = opts?.showProgress !== false;
  const todos = new Map<string, Todo[]>(); // sessionId -> todo list

  // Closure-bound state for todo_write tool (no ctx in Tool.execute)
  let activeSessionId = "";
  let onUpdate: (todos: Todo[]) => void = () => {};

  const todoWriteTool = createTodoWriteTool({
    getTodos: (sid) => todos.get(sid),
    setTodos: (sid, list) => todos.set(sid, list),
    getActiveSessionId: () => activeSessionId,
    onUpdate: (list) => onUpdate(list),
  });

  return definePlugin({
    name: "todo",
    tools: [todoWriteTool],
    hooks: {
      async beforeModel(ctx, messages) {
        activeSessionId = ctx.sessionId;
        onUpdate = (list: Todo[]) => {
          ctx.emit?.({
            type: "todo_update",
            spanId: ctx.span?.spanId,
            payload: { todos: list },
          });
        };

        if (!showProgress) return [...messages];

        const list = todos.get(ctx.sessionId);
        if (!list?.length) return [...messages];

        const view = list
          .map((t) => {
            const mark = t.status === "done" ? "x" : t.status === "in_progress" ? ">" : " ";
            return `- [${mark}] ${t.step}`;
          })
          .join("\n");
        ctx.context.set(TodoKey, `<todo>\n${view}\n</todo>`);
        return [...messages];
      },
    },
  });
}
