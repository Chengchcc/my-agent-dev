import type { Agent } from '../../agent';
import type { SessionStore } from '../../session/store';

/**
 * Todo item for display in UI.
 */
export interface UITodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

/**
 * Context passed to command handlers
 */
export interface CommandHandlerContext {
  agent: Agent;
  onOutput: (message: string) => void;
  refreshMessages: () => void;
  sessionStore: SessionStore;
  args: string;
}
