// Todo item status values
export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

// Single todo item
export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}
