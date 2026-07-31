import { describe, expect, test } from "bun:test";
import { createInMemorySessionStore, readTodo } from "@my-agent-team/agent";
import { createTodoPlugin } from "./todo.js";

describe("plugin-todo", () => {
  test("todo_write persists to SessionStore", async () => {
    const store = createInMemorySessionStore();
    const sid = "todo-test";
    await store.create({
      sessionId: sid,
      backendKind: "coding_agent",
      workspaceRoot: "/ws",
      modelRef: { backendKind: "test", modelId: "m1" },
      systemPromptHash: null,
      activeLoopId: null,
      leafEntryId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const plugin = createTodoPlugin({ sessionId: sid, store });
    expect(plugin.name).toBe("todo");
    expect(plugin.tools).toHaveLength(1);
    expect(plugin.tools?.[0]?.name).toBe("todo_write");

    // Execute todo_write
    const tool = plugin.tools![0]!;
    const result = await tool.execute({ items: [{ id: "t1", text: "task 1", status: "pending" }] });
    expect((result as { items: unknown[] }).items).toHaveLength(1);

    // Verify persisted
    const state = await readTodo(store, sid);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.id).toBe("t1");
  });
});
