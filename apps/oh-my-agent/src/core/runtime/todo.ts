import type { SessionStore } from "../persistence/session-store.js";
import type { TodoStateEntry } from "../persistence/session-tree.js";

export interface TodoItem {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "in_progress" | "done" | "cancelled";
}

export interface TodoState {
  readonly items: readonly TodoItem[];
}

/** Read the latest todo state from the current branch. */
export async function readTodo(store: SessionStore, sessionId: string): Promise<TodoState> {
  const branch = await store.readBranch(sessionId);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "todo") {
      return (entry as TodoStateEntry).state as unknown as TodoState;
    }
  }
  return { items: [] };
}

/** Append a new todo state entry. */
export async function writeTodo(
  store: SessionStore,
  sessionId: string,
  state: TodoState,
): Promise<void> {
  await store.appendBatch(sessionId, {
    entries: [
      {
        type: "todo" as const,
        state: state as unknown as Record<string, unknown>,
        createdAt: Date.now(),
      },
    ],
  });
}

/** Merge todo updates: apply changes to current state and persist. */
export async function updateTodo(
  store: SessionStore,
  sessionId: string,
  updates: readonly Partial<TodoItem>[],
): Promise<TodoState> {
  const current = await readTodo(store, sessionId);
  const items = [...current.items];
  for (const update of updates) {
    const idx = items.findIndex((i) => i.id === update.id);
    if (idx >= 0) {
      items[idx] = { ...items[idx]!, ...update };
    } else if (update.id && update.text) {
      items.push({ id: update.id, text: update.text, status: update.status ?? "pending" });
    }
  }
  const newState: TodoState = { items };
  await writeTodo(store, sessionId, newState);
  return newState;
}
