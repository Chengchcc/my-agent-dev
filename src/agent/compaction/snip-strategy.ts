import type { CompressionStrategy, AgentContext, Message } from '../../types';
import { nanoid } from 'nanoid';

const DEFAULT_SNIP_KEEP_TAIL = 6;
const NANOID_LENGTH = 6;

/**
 * L1 Compression: Snip out middle messages to free up space.
 * Keeps system messages, the starting conversation, and the recent working context.
 */
export class SnipStrategy implements CompressionStrategy {
  private readonly keepHead: number;
  private readonly keepTail: number;

  constructor(options?: { keepHead?: number; keepTail?: number }) {
    this.keepHead = options?.keepHead ?? 2;
    this.keepTail = options?.keepTail ?? DEFAULT_SNIP_KEEP_TAIL;
  }

  async compress(context: AgentContext, _tokenLimit: number): Promise<Message[]> {
    let messages = [...context.messages];

    // Keep all system messages separate
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    const EXTRA_MARGIN = 2;
    // If we don't have many messages, nothing to do
    if (nonSystemMessages.length <= this.keepHead + this.keepTail + EXTRA_MARGIN) {
      return [...systemMessages, ...nonSystemMessages];
    }

    // Keep head (first N) and tail (last N), remove everything in between
    const head = nonSystemMessages.slice(0, this.keepHead);
    const tail = nonSystemMessages.slice(-this.keepTail);

    // Add a marker that content was snipped
    const snipMarker: Message = {
      id: `snip-${nanoid(NANOID_LENGTH)}`,
      role: 'system',
      content: '[Earlier conversation history was snipped to save context space]',
    };

    const result = [...systemMessages, ...head, snipMarker, ...tail];

    // Still over limit? Remove one more from the middle (between head and marker)
    // Recalculate tokens if needed, but typically this is enough
    return result;
  }
}