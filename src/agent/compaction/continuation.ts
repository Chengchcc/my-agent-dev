import type { Message } from '../../types';
import type { TodoItem } from '../../todos/types';
import type { CompactionResult } from './types';

/**
 * Build a continuation message to inject after compaction.
 * This orients the LLM after context was compressed and
 * provides all necessary context for continuation.
 */
export function buildContinuationMessage(
  result: CompactionResult,
  activeFiles: string[],
  activeTodos: TodoItem[],
): Message {
  const sections: string[] = [];

  // 1. Compaction notice with metrics
  sections.push(
    `---\n` +
    `⚠️ **Context Compaction** (Tier ${result.tier})\n` +
    `Tokens: ${result.tokensBefore} → ${result.tokensAfter}\n` +
    `---`
  );

  // 2. Summary from compaction
  if (result.summary) {
    sections.push(`## Conversation Summary\n\n${result.summary}`);
  }

  // 3. Active files hint - suggest re-reading if needed
  if (activeFiles.length > 0) {
    sections.push(
      `## Recently Active Files\n\n` +
      `These files were referenced before compaction. Re-read them if you need the full content:\n` +
      activeFiles.map(f => `- \`${f}\``).join('\n')
    );
  }

  // 4. Active todo list
  if (activeTodos.length > 0) {
    sections.push(
      `## Active TODO List\n\n` +
      activeTodos.map(t =>
        `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}`
      ).join('\n')
    );
  }

  // 5. Final instructions
  sections.push(
    `## Instructions\n\n` +
    `Continue from where you left off. The user's most recent messages are preserved above. ` +
    `If you need file contents that were in the compacted portion, use the read tool to re-read them.`
  );

  return {
    role: 'user',
    content: sections.join('\n\n'),
  };
}
