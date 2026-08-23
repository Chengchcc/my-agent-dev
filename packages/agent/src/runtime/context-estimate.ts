/** Context-token estimation helpers absorbed from oh-my-pi
 * (packages/agent/src/harness/compaction/compaction.ts):
 * usage-anchored estimation + silent-overflow detection. */

/** Per-turn usage quartet (concrete, unlike the all-optional run Usage). */
export interface TurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** A real-usage anchor: `tokens` is a completed model call's own total
 * (input + output + cache legs) and is authoritative for every entry
 * persisted before `afterEntryId`; only entries AFTER it fall back to
 * per-message estimation (chars/4). Falls back wholesale when the anchor
 * entry no longer exists (post-compaction branch, resumed runs).
 *
 * ponytail: the anchor is in-memory per Run — pi persists usage on
 * assistant messages and re-anchors after resume. Persist it onto the
 * session file if follow-up Runs ever drift badly. */
export interface UsageAnchor {
  readonly afterEntryId: string | null;
  readonly tokens: number;
}

export function usageTotalTokens(usage: TurnUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** Context size estimate anchored on the last real usage: anchor tokens +
 * per-entry estimates for entries persisted after the anchor boundary.
 * Without an anchor (or when the boundary entry is gone) every entry is
 * estimated — the pre-anchor behavior. */
export function estimateContextTokens<T extends { entryId: string }>(
  entries: readonly T[],
  anchor: UsageAnchor | null,
  estimateEntry: (entry: T) => number,
): number {
  const fallback = (): number => entries.reduce((sum, e) => sum + estimateEntry(e), 0);
  if (!anchor) return fallback();
  const idx =
    anchor.afterEntryId === null ? -1 : entries.findIndex((e) => e.entryId === anchor.afterEntryId);
  if (anchor.afterEntryId !== null && idx === -1) return fallback();
  return anchor.tokens + entries.slice(idx + 1).reduce((sum, e) => sum + estimateEntry(e), 0);
}

/** Silent context overflow (oh-my-pi isContextOverflow): some providers
 * accept an oversized request instead of erroring.
 * - zai-style: the input side exceeds the model window — never legitimate.
 * - Xiaomi-style: input truncated to exactly fill the window, leaving zero
 *   room to generate (length-stop with zero output). */
export function isSilentContextOverflow(
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined,
  stopReason: string | undefined,
  contextLimit: number,
): boolean {
  if (!usage || contextLimit <= 0) return false;
  const input = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0);
  if (input <= 0) return false;
  if (input > contextLimit) return true;
  return (
    stopReason === "max_tokens" && (usage.outputTokens ?? 0) === 0 && input >= contextLimit * 0.99
  );
}
