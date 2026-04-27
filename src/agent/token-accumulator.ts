import { countTokens } from '@anthropic-ai/tokenizer';
import type { Message } from '../types';

/**
 * Incremental token tracker with per-message caching.
 *
 * Instead of O(messages) re-scan every turn, this maintains a running total
 * via delta updates on append, remove, and batch replace (compaction).
 *
 * Estimation strategy:
 * - Messages: uses @anthropic-ai/tokenizer (WASM, accurate)
 * - Tools schema: tracked separately, updated when provider registers tools
 * - System prompt: tracked separately for invalidation
 */
export class TokenAccumulator {
  private perMessage = new Map<string, number>();
  private _toolsTokens = 0;
  private _systemPromptTokens = 0;
  private _total = 0;

  /** Total estimated tokens (messages + tools + system prompt). */
  get total(): number {
    return this._total;
  }

  /** Tools schema token count (separate from messages). */
  get toolsTokens(): number {
    return this._toolsTokens;
  }

  /** System prompt token count. */
  get systemPromptTokens(): number {
    return this._systemPromptTokens;
  }

  /** Set tools schema token count. Delta-applied to total. */
  setTools(tokens: number): void {
    this._total += tokens - this._toolsTokens;
    this._toolsTokens = tokens;
  }

  /** Set system prompt token count. Delta-applied to total. */
  setSystemPrompt(tokens: number): void {
    this._total += tokens - this._systemPromptTokens;
    this._systemPromptTokens = tokens;
  }

  /** Add a single message. O(1) amortized. Returns tokens for this message. */
  add(msg: Message): number {
    const id = msg.id;
    if (!id) {
      // Messages without IDs can't be tracked per-message, but we still return the count
      return estimateMessage(msg);
    }
    if (this.perMessage.has(id)) return 0; // already tracked

    const t = estimateMessage(msg);
    this.perMessage.set(id, t);
    this._total += t;
    return t;
  }

  /** Remove a single message by id. No-op if not found. */
  remove(id: string): void {
    const t = this.perMessage.get(id);
    if (t === undefined) return;
    this.perMessage.delete(id);
    this._total -= t;
  }

  /**
   * Replace all messages (e.g. after compaction).
   * Computes the diff between old and new message sets to avoid O(N) re-scan
   * when most messages are unchanged.
   */
  setMessages(messages: Message[]): void {
    const newIds = new Set<string>();
    let added = 0;
    const addedIds: string[] = [];

    for (const msg of messages) {
      if (!msg.id) continue;
      newIds.add(msg.id);
      if (!this.perMessage.has(msg.id)) {
        const t = estimateMessage(msg);
        this.perMessage.set(msg.id, t);
        added += t;
        addedIds.push(msg.id);
      }
    }

    // Remove messages no longer present
    let removed = 0;
    for (const id of this.perMessage.keys()) {
      if (!newIds.has(id)) {
        const t = this.perMessage.get(id)!;
        removed += t;
        this.perMessage.delete(id);
      }
    }

    this._total += added - removed;
  }

  /** Reconcile a single message with exact token count (L2 anchor). */
  reconcile(id: string, exactTokens: number): void {
    const old = this.perMessage.get(id);
    if (old === undefined) {
      this.perMessage.set(id, exactTokens);
      this._total += exactTokens;
      return;
    }
    this.perMessage.set(id, exactTokens);
    this._total += exactTokens - old;
  }

  /** Clear all state. */
  clear(): void {
    this.perMessage.clear();
    this._toolsTokens = 0;
    this._systemPromptTokens = 0;
    this._total = 0;
  }

  /** Number of tracked messages. */
  get size(): number {
    return this.perMessage.size;
  }
}

/**
 * Estimate tokens for a single message using @anthropic-ai/tokenizer.
 * Falls back to chars/4 on error.
 */
function estimateMessage(msg: Message): number {
  let tokens = 4; // overhead per message for role/metadata
  try {
    if (msg.content) {
      tokens += countTokens(msg.content);
    }
    if (msg.tool_calls) {
      tokens += countTokens(JSON.stringify(msg.tool_calls));
    }
    if (msg.tool_call_id) {
      tokens += countTokens(msg.tool_call_id) + 2; // tool_call_id + overhead
    }
  } catch {
    // Fallback for strings with special Unicode that break the tokenizer
    if (msg.content) tokens += Math.ceil(msg.content.length / 4);
    if (msg.tool_calls) tokens += Math.ceil(JSON.stringify(msg.tool_calls).length / 4);
  }
  return tokens;
}
