import { describe, expect, test } from "bun:test";
import { createInMemorySessionStore, readTodo } from "../agent-runtime.js";
import { createTodo } from "./todo.js";

describe("todo", () => {
  test("todo_write persists to SessionStore", async () => {
    const store = createInMemorySessionStore();
    const sid = "todo-test";
    await store.create({
      sessionId: sid,
      backendKind: "oma",
      workspaceRoot: "/ws",
      leafEntryId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const plugin = createTodo({ sessionId: sid, store });
    expect(plugin.name).toBe("todo");
    expect(plugin.tools).toHaveLength(1);
    expect(plugin.tools?.[0]?.name).toBe("todo_write");

    const tool = plugin.tools![0]!;
    const result = await tool.execute({ items: [{ id: "t1", text: "task 1", status: "pending" }] });
    if ("items" in result && Array.isArray(result.items)) {
      expect(result.items).toHaveLength(1);
    }

    const state = await readTodo(store, sid);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.id).toBe("t1");
  });

  test("afterTool emits todo_update only for todo_write", async () => {
    const store = createInMemorySessionStore();
    const sid = "todo-hook";
    await store.create({
      sessionId: sid,
      backendKind: "oma",
      workspaceRoot: "/ws",
      leafEntryId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const plugin = createTodo({ sessionId: sid, store });
    const hook = plugin.hooks?.afterTool;
    expect(hook).toBeDefined();

    const ev = hook!(
      "todo_write",
      {
        items: [
          { id: "a", text: "step 1", status: "done" },
          { id: "b", text: "step 2", status: "pending" },
        ],
      },
      undefined as never,
    );
    expect(ev).toEqual({
      type: "todo_update",
      items: [
        { id: "a", text: "step 1", status: "done" },
        { id: "b", text: "step 2", status: "pending" },
      ],
    });

    expect(hook!("ls", {}, undefined as never)).toBeUndefined();
  });
});
