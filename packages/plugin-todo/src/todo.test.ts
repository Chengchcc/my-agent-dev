import { describe, expect, it } from "bun:test";
import type { HookContext } from "@my-agent-team/agent";
import type { Message } from "@my-agent-team/message";
import { type Todo, TodoKey, todoPlugin } from "./todo.js";

/** Minimal fake HookContext for testing beforeModel. */
function fakeCtx(sessionId: string, emit?: (e: unknown) => void) {
  const map = new Map<string, unknown>();
  return {
    sessionId,
    emit: emit as never,
    messageStore: { load: async () => null, save: async () => {} },
    eventLog: undefined,
    interruptStore: undefined,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    contextManager: { shape: (_ctx: unknown, msgs: readonly never[]) => [...msgs] },
    context: {
      get: <T>(key: { name: string }): T | undefined => map.get(key.name) as T | undefined,
      set: <T>(key: { name: string }, value: T): void => {
        map.set(key.name, value);
      },
      has: (key: { name: string }): boolean => map.has(key.name),
      delete: (key: { name: string }): boolean => map.delete(key.name),
      clear: (): void => {
        map.clear();
      },
    },
  } as unknown as HookContext;
}

describe("todoPlugin", () => {
  describe("plugin shape", () => {
    it("returns a plugin with name 'todo', beforeModel hook, and tools", () => {
      const plugin = todoPlugin();
      expect(plugin.name).toBe("todo");
      expect(plugin.hooks).toBeDefined();
      expect(typeof plugin.hooks!.beforeModel).toBe("function");
      expect(plugin.tools).toBeDefined();
      expect(plugin.tools!.map((t) => t.name)).toContain("todo_write");
    });
  });

  describe("todo_write tool - CRUD", () => {
    it("adds steps", async () => {
      const plugin = todoPlugin();
      const tool = plugin.tools!.find((t) => t.name === "todo_write")!;

      // beforeModel sets activeSessionId via ctx
      await plugin.hooks!.beforeModel!(fakeCtx("s1"), [{ role: "system", text: "sys" }]);

      const result = await tool.execute({
        action: "add",
        steps: ["Read config", "Update port", "Restart service"],
      });
      expect(result.content).toContain("[ ] Read config");
      expect(result.content).toContain("[ ] Update port");
      expect(result.content).toContain("[ ] Restart service");
    });

    it("updates step status", async () => {
      const plugin = todoPlugin();
      const tool = plugin.tools!.find((t) => t.name === "todo_write")!;

      await plugin.hooks!.beforeModel!(fakeCtx("s1"), [{ role: "system", text: "sys" }]);
      await tool.execute({ action: "add", steps: ["Step A", "Step B"] });

      const result = await tool.execute({
        action: "update",
        updates: [{ step: "Step A", status: "in_progress" }],
      });
      expect(result.content).toContain("[>] Step A");
      expect(result.content).toContain("[ ] Step B");
    });

    it("moves steps up and down", async () => {
      const plugin = todoPlugin();
      const tool = plugin.tools!.find((t) => t.name === "todo_write")!;

      await plugin.hooks!.beforeModel!(fakeCtx("s1"), [{ role: "system", text: "sys" }]);
      await tool.execute({ action: "add", steps: ["First", "Second", "Third"] });

      // Move "Second" up -> becomes first
      const up = await tool.execute({ action: "move", step: "Second", direction: "up" });
      const lines = up.content.split("\n");
      expect(lines[0]).toContain("Second");

      // Move "Second" back down
      const down = await tool.execute({ action: "move", step: "Second", direction: "down" });
      const lines2 = down.content.split("\n");
      expect(lines2[1]).toContain("Second");
    });

    it("deletes steps", async () => {
      const plugin = todoPlugin();
      const tool = plugin.tools!.find((t) => t.name === "todo_write")!;

      await plugin.hooks!.beforeModel!(fakeCtx("s1"), [{ role: "system", text: "sys" }]);
      await tool.execute({ action: "add", steps: ["Keep", "Delete me"] });

      const result = await tool.execute({ action: "delete", steps: ["Delete me"] });
      expect(result.content).toContain("Keep");
      expect(result.content).not.toContain("Delete me");
    });

    it("emits todo_update event on each operation", async () => {
      const plugin = todoPlugin();
      const tool = plugin.tools!.find((t) => t.name === "todo_write")!;
      const events: unknown[] = [];

      await plugin.hooks!.beforeModel!(
        fakeCtx("s1", (e: unknown) => events.push(e)),
        [{ role: "system", text: "sys" }],
      );

      await tool.execute({ action: "add", steps: ["Step"] });
      expect(events).toHaveLength(1);
      const ev = events[0] as { type: string; payload: { todos: Todo[] } };
      expect(ev.type).toBe("todo_update");
      expect(ev.payload.todos).toHaveLength(1);
      expect(ev.payload.todos[0]!.step).toBe("Step");
    });
  });

  describe("beforeModel - progress injection", () => {
    it("does not inject when todos list is empty", async () => {
      const plugin = todoPlugin();
      const msgs: Message[] = [
        { role: "system", text: "sys" },
        { role: "user", text: "hi" },
      ];
      const result = await plugin.hooks!.beforeModel!(fakeCtx("s1"), msgs);
      expect(result).toHaveLength(2);
      expect(result[0]!.text).toBe("sys");
    });

    it("does not inject when showProgress is false", async () => {
      const plugin = todoPlugin({ showProgress: false });
      const tool = plugin.tools!.find((t) => t.name === "todo_write")!;

      // Seed todos
      await plugin.hooks!.beforeModel!(fakeCtx("s1"), [{ role: "system", text: "sys" }]);
      await tool.execute({ action: "add", steps: ["Step A"] });

      // Even with todos, showProgress=false should not inject
      const msgs: Message[] = [
        { role: "system", text: "sys" },
        { role: "user", text: "hi" },
      ];
      const result = await plugin.hooks!.beforeModel!(fakeCtx("s1"), msgs);
      expect(result).toHaveLength(2);
      expect(result[0]!.text).toBe("sys");
    });

    it("writes <todo> block to context store when todos exist", async () => {
      const plugin = todoPlugin();
      const tool = plugin.tools!.find((t) => t.name === "todo_write")!;

      // Seed todos with mixed statuses
      const ctx = fakeCtx("s1");
      await plugin.hooks!.beforeModel!(ctx, [{ role: "system", text: "sys" }]);
      await tool.execute({ action: "add", steps: ["Done step", "Active step", "Pending step"] });
      await tool.execute({
        action: "update",
        updates: [
          { step: "Done step", status: "done" },
          { step: "Active step", status: "in_progress" },
        ],
      });

      // Now beforeModel should write progress to context store
      const msgs: Message[] = [
        { role: "system", text: "sys" },
        { role: "user", text: "hi" },
      ];
      const result = await plugin.hooks!.beforeModel!(ctx, msgs);
      // Messages unchanged - progress goes to context store, not system message
      expect(result).toHaveLength(2);
      expect(result[0]!.text).toBe("sys");
      // Context store has the todo block
      const stored = ctx.context.get(TodoKey);
      expect(stored).toContain("<todo>");
      expect(stored).toContain("[x] Done step");
      expect(stored).toContain("[>] Active step");
      expect(stored).toContain("[ ] Pending step");
      expect(stored).toContain("</todo>");
    });
  });
});
