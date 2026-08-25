import type { Message } from "@chengchenccc/message";

/** Per-entry token-estimate memoization:
 *
 *  Long sessions re-walk the settled branch every turn to compute total
 *  tokens for threshold-compaction checks. Settled messages (append-only,
 *  never mutated outside compaction) are estimated once and reused until
 *  compaction clears the cache.
 *
 *  Keys on the session-tree entryId, which is stable and unique. Clear on
 *  compaction — covered entries are gone, surviving ones may have shifted. */
export class TokenEstimateCache {
  private readonly cache = new Map<string, number>();

  estimate(entryId: string, message: Message, estimator: (message: Message) => number): number {
    const cached = this.cache.get(entryId);
    if (cached !== undefined) return cached;
    const tokens = estimator(message);
    this.cache.set(entryId, tokens);
    return tokens;
  }

  clear(): void {
    this.cache.clear();
  }
}
