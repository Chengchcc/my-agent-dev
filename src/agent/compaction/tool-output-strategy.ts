import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { nanoid } from 'nanoid';
import type { CompressionStrategy, AgentContext, Message } from '../../types';

const HOT_TAIL_SIZE = 3; // Keep last N tool outputs inline
const MAX_INLINE_CHARS = 2000; // Max chars before offline
const PREVIEW_CHARS = 200; // Preview chars to keep inline

/**
 * L2 Compression: Offline large tool outputs to disk, keep references.
 * Only keeps the most recent (hot tail) tool outputs inline.
 */
export class ToolOutputStrategy implements CompressionStrategy {
  private readonly hotTailSize: number;
  private readonly maxInlineChars: number;
  private readonly previewChars: number;
  private readonly storageDir: string;

  constructor(options?: {
    hotTailSize?: number;
    maxInlineChars?: number;
    previewChars?: number;
    storageDir?: string;
  }) {
    this.hotTailSize = options?.hotTailSize ?? HOT_TAIL_SIZE;
    this.maxInlineChars = options?.maxInlineChars ?? MAX_INLINE_CHARS;
    this.previewChars = options?.previewChars ?? PREVIEW_CHARS;
    this.storageDir = options?.storageDir ?? path.join(os.homedir(), '.my-agent', 'tool-outputs');
  }

  async compress(context: AgentContext, tokenLimit: number): Promise<Message[]> {
    const messages = [...context.messages];

    // Find all tool messages
    const toolMessages: Array<{ msg: Message; index: number }> = [];
    messages.forEach((msg, index) => {
      if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > this.maxInlineChars) {
        toolMessages.push({ msg, index });
      }
    });

    // Keep last N tool messages inline, offline the rest
    const coldTools = toolMessages.slice(0, -this.hotTailSize);

    if (coldTools.length === 0) {
      return messages;
    }

    // Ensure storage directory exists
    await fs.mkdir(this.storageDir, { recursive: true });

    // Offline each cold tool output
    for (const { msg, index } of coldTools) {
      const refPath = await this.saveToDisk(msg.content);
      const preview = msg.content.slice(0, this.previewChars);
      messages[index] = {
        ...msg,
        content: `[Tool output saved to ${refPath}. ${msg.content.length} characters total.\n\nPreview: ${preview}${msg.content.length > this.previewChars ? '\n...' : ''}]`,
      };
    }

    return messages;
  }

  private async saveToDisk(content: string): Promise<string> {
    const filename = `${nanoid()}.txt`;
    const filepath = path.join(this.storageDir, filename);
    await fs.writeFile(filepath, content, 'utf8');
    return filepath;
  }
}