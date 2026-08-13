/** Wake routing (conversation auto-trigger): pick which agents to wake when
 *  no @mention addresses a specific member. The relationship-graph variant
 *  died with the relationships feature (removed) — the no-graph fallback is
 *  now the whole function. */
export function selectWakeAgentIDs(
  activeAgentIds: string[],
  mentionedIds: string[],
  hasMention: boolean,
): string[] {
  // 1. Mentioned agents -> only wake those that are active
  if (mentionedIds.length > 0) {
    const mentioned = new Set(mentionedIds);
    return activeAgentIds.filter((id) => mentioned.has(id));
  }
  // 2. Has @mention pattern but none matched -> suppress all
  if (hasMention) return [];
  // 3. No mention -> wake the first active agent (no coordinator graph)
  return activeAgentIds.length > 0 ? [activeAgentIds[0]!] : [];
}
