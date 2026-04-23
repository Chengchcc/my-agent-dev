import Anthropic from '@anthropic-ai/sdk';
import type { Message } from '../types';

/**
 * Convert unified message format to Claude API message format.
 * - Removes system messages (Claude expects system as separate parameter)
 * - Converts tool messages to user messages with tool_result content blocks
 * - Converts assistant messages with tool calls to mixed content blocks
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
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        // Assistant message with tool calls - need to create mixed content blocks
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
        return {
          role: 'assistant',
          content,
        };
      }
      return {
        role: m.role === 'assistant' ? 'assistant' : 'user',
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
