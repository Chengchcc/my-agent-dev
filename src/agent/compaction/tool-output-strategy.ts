import type { CompressionStrategy, AgentContext, Message } from '../../types';

const HOT_TAIL_SIZE = 3; // Keep last N tool outputs inline
const MAX_INLINE_CHARS = 2000; // Max chars before truncation
const PREVIEW_CHARS = 200; // Preview chars to keep inline

/**
 * L2 Compression: Truncate large tool outputs inline, keeping head+tail previews.
 * Only keeps the most recent (hot tail) tool outputs fully inline.
 * Does NOT persist to disk — avoids leaking sensitive data.
 */
export class ToolOutputStrategy implements CompressionStrategy {
  private readonly hotTailSize: number;
  private readonly maxInlineChars: number;
  private readonly previewChars: number;

  constructor(options?: {
    hotTailSize?: number;
    maxInlineChars?: number;
    previewChars?: number;
  }) {
    this.hotTailSize = options?.hotTailSize ?? HOT_TAIL_SIZE;
    this.maxInlineChars = options?.maxInlineChars ?? MAX_INLINE_CHARS;
    this.previewChars = options?.previewChars ?? PREVIEW_CHARS;
  }

  async compress(context: AgentContext, _tokenLimit: number): Promise<Message[]> {
    const messages = [...context.messages];

    // Find all tool messages
    const toolMessages: Array<{ msg: Message; index: number }> = [];
    messages.forEach((msg, index) => {
      if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > this.maxInlineChars) {
        toolMessages.push({ msg, index });
      }
    });

    // Keep last N tool messages inline, truncate the rest
    const coldTools = toolMessages.slice(0, -this.hotTailSize);

    if (coldTools.length === 0) {
      return messages;
    }

    // Truncate each cold tool output inline (no disk persistence)
    for (const { msg, index } of coldTools) {
      const preview = msg.content.slice(0, this.previewChars);
      const tail = msg.content.slice(-this.previewChars);
      messages[index] = {
        ...msg,
        content: `[Truncated: ${msg.content.length} chars → head+tail previews only]\n\n${preview}\n...\n${tail}`,
      };
    }

    return messages;
  }
}