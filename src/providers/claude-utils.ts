import Anthropic from '@anthropic-ai/sdk';
import type { Message } from '../types';

/**
 * Convert unified message format to Claude API message format.
 * - Removes system messages (Claude expects system as separate parameter)
 * - Converts tool messages to user messages with tool_result content blocks
 * - Converts assistant messages with blocks (thinking/text/tool_use) preserving order:
 *   thinking → redacted_thinking → text → tool_use (Anthropic requirement)
 */
export function convertToClaudeMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages
    .filter(m => m.role !== 'system')
    .map(m => {
      if (m.role === 'tool') {
        // Claude expects tool results as user messages with tool_result content blocks
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: m.tool_call_id!,
              content: m.content,
            },
          ],
        };
      }

      if (m.role === 'assistant') {
        // Prefer structured blocks when available — preserves thinking signature for re-submission
        if (m.blocks && m.blocks.length > 0) {
          const content: Anthropic.ContentBlockParam[] = [];
          // Enforce Anthropic-required ordering: thinking → redacted_thinking → text → tool_use
          const ordered = [...m.blocks].sort((a, b) => {
            const order: Record<string, number> = { thinking: 0, redacted_thinking: 1, text: 2, tool_use: 3, tool_result: 4 };
            return (order[a.type] ?? 5) - (order[b.type] ?? 5);
          });
          for (const block of ordered) {
            switch (block.type) {
              case 'thinking':
                content.push({
                  type: 'thinking' as Anthropic.ContentBlockParam['type'],
                  thinking: block.thinking,
                  ...(block.signature ? { signature: block.signature } : {}),
                } as Anthropic.ContentBlockParam);
                break;
              case 'redacted_thinking':
                content.push({
                  type: 'redacted_thinking' as Anthropic.ContentBlockParam['type'],
                  data: block.data,
                } as Anthropic.ContentBlockParam);
                break;
              case 'text':
                content.push({ type: 'text', text: block.text });
                break;
              case 'tool_use':
                content.push({
                  type: 'tool_use',
                  id: block.id,
                  name: block.name,
                  input: block.input,
                });
                break;
            }
          }
          return { role: 'assistant', content };
        }

        // Legacy path: construct blocks from content + tool_calls
        if (m.tool_calls && m.tool_calls.length > 0) {
          const content: Anthropic.ContentBlockParam[] = [];
          if (m.content) {
            content.push({ type: 'text', text: m.content });
          }
          for (const tc of m.tool_calls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
          return { role: 'assistant', content };
        }

        return { role: 'assistant', content: m.content };
      }

      return {
        role: 'user',
        content: m.content,
      };
    }) as Anthropic.MessageParam[];
}

/**
 * Extract system prompt from messages array for Claude API.
 */
export function extractSystemPrompt(messages: Message[]): string {
  return messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
}
