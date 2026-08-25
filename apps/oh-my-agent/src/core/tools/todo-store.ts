import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CodingSessionEntry,
  CodingSessionSnapshot,
  SessionStore,
  TodoItem,
} from "../agent-runtime.js";

/** Standalone oma's local todo store: a single `.oma/todo.json` in the
 *  workspace, so todo_write persists across TUI runs (unlike the per-Run
 *  in-memory SessionStore that backend product tools use). Backend-invoked
 *  RPC mode gets todo via the backend-injected MCP, never this file. */
const TODO_REL_PATH = ".oma/todo.json";

function isTodoItem(value: unknown): value is TodoItem {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "text" in value &&
    typeof value.text === "string" &&
    "status" in value &&
    typeof value.status === "string"
  );
}

export function readTodoFile(workspaceRoot: string): readonly TodoItem[] {
  const path = join(workspaceRoot, TODO_REL_PATH);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items.filter(isTodoItem);
  } catch {
    return [];
  }
}

export function writeTodoFile(workspaceRoot: string, items: readonly TodoItem[]): void {
  const path = join(workspaceRoot, TODO_REL_PATH);
  mkdirSync(join(workspaceRoot, ".oma"), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ items }, null, 2)}\n`);
}

/** SessionStore shim that satisfies the todo plugin's read/write contract,
 *  but persists todo entries to the workspace file instead of the per-Run
 *  in-memory branch. Every other SessionStore method is a no-op. */
export function createFileTodoStore(workspaceRoot: string): SessionStore {
  return {
    async create() {
      // Nothing to create; the file is written lazily on first todo_write.
    },
    async open() {
      const snapshot: CodingSessionSnapshot = {
        metadata: {
          sessionId: "",
          backendKind: "oma",
          workspaceRoot,
          leafEntryId: null,
          createdAt: 0,
          updatedAt: 0,
        },
        entries: [],
        operations: [],
      };
      return snapshot;
    },
    async delete() {
      // todo.json is shared across sessions in a workspace; /delete stays local.
    },
    async appendBatch(_sessionId, input) {
      for (const entry of input.entries) {
        if (entry.type !== "todo") continue;
        if (!("state" in entry) || typeof entry.state !== "object" || entry.state === null)
          continue;
        const state = entry.state;
        if (!("items" in state) || !Array.isArray(state.items)) continue;
        const items = state.items.filter(isTodoItem);
        writeTodoFile(workspaceRoot, items);
      }
      return { appendedIds: input.entries.map((_, i) => `todo-${i}`) };
    },
    async readBranch() {
      const items = readTodoFile(workspaceRoot);
      if (items.length === 0) return [];
      const entry: CodingSessionEntry = {
        type: "todo",
        entryId: "todo-file",
        parentId: null,
        state: { items },
        createdAt: Date.now(),
      };
      return [entry];
    },
    async moveLeaf() {
      // No leaf operations on a file-backed todo store.
    },
    async findByProductEntryIds() {
      return [];
    },
    async close() {
      // No resources to release.
    },
  };
}
