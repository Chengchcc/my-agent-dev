import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTodoStore, readTodoFile, writeTodoFile } from "./todo-store.js";

describe("todo store", () => {
  test("write/read file round trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-todo-"));
    try {
      const items = [{ id: "t1", text: "plan", status: "pending" }] as const;
      writeTodoFile(dir, items);
      expect(readTodoFile(dir)).toEqual(items);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file-backed store appendBatch then readBranch persists todo entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-todo2-"));
    try {
      const store = createFileTodoStore(dir);
      await store.appendBatch("s", {
        entries: [
          {
            type: "todo",
            state: { items: [{ id: "a", text: "x", status: "in_progress" }] },
            createdAt: 1,
          },
        ],
      });
      const branch = await store.readBranch("s");
      expect(branch).toHaveLength(1);
      const entry = branch[0];
      expect(entry?.type).toBe("todo");
      if (entry?.type === "todo") {
        expect(entry.state).toEqual({
          items: [{ id: "a", text: "x", status: "in_progress" }],
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
