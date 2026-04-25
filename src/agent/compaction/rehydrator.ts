import type { Message } from '../../types';
import type { ContextManager } from '../context';
import type { CompactionResult } from './types';

/**
 * Rehydrates critical state after compaction:
 * - Restores todo list from metadata
 * - Auto-re-reads 5 most recent files to restore context
 */
export class Rehydrator {

  async rehydrate(
    compactedResult: CompactionResult,
    contextManager: ContextManager,
  ): Promise<Message[]> {
    let messages = [...compactedResult.messages];
    const context = contextManager.getContext({
      tokenLimit: contextManager.getTokenLimit(),
    });

    // 1. Restore todo state from metadata if available
    if (context.metadata?.todo) {
      const todoState = context.metadata.todo as {
        todoStore: Array<{ status: string; text: string }>;
      };
      if (todoState.todoStore && todoState.todoStore.length > 0) {
        const todoSummary = todoState.todoStore
          .map(t => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.text}`)
          .join('\n');
        messages.push({
          role: 'user',
          content: `[Restored todo state]\n${todoSummary}`,
        });
      }
    }

    // 2. Extract and rehydrate recent files if we have them stored
    // For now, this is a placeholder - file access tracking will be added later
    // Currently just returns the messages as-is

    return messages;
  }
}
