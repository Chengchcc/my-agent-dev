// Todo item status values
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

// Single todo item
export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}
