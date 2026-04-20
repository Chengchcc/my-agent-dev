import type { Message } from '../../types';

/**
 * Message in the chat history for UI rendering.
 */
export interface UIMessage {
  role: 'user' | 'assistant';
  content: string;
  tool_calls?: {
    name: string;
    arguments: Record<string, unknown>;
  }[];
}

/**
 * Todo item for display in UI.
 */
export interface UITodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}
