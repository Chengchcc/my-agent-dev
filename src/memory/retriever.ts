import type { MemoryEntry, MemoryRetriever, MemoryStore } from './types';

export class KeywordRetriever implements MemoryRetriever {
  constructor(
    private semanticStore: MemoryStore,
    private episodicStore: MemoryStore,
    private projectStore: MemoryStore,
  ) {}

  async search(
    query: string,
    options: { limit?: number; projectPath?: string; type?: 'semantic' | 'episodic' | 'project'; threshold?: number } = {},
  ): Promise<MemoryEntry[]> {
    const { limit = 10, projectPath, type, threshold = 0.1 } = options;
    const queryTokens = this.tokenize(query.toLowerCase());

    // Get candidates — filter by type if specified
    const semanticEntries = (!type || type === 'semantic') ? await this.semanticStore.getAll() : [];
    const episodicEntries = (!type || type === 'episodic') ? await this.episodicStore.getAll() : [];

    let candidates = [...semanticEntries, ...episodicEntries];

    // If projectPath provided, always include project memory
    let projectEntry: MemoryEntry | null = null;
    if (projectPath) {
      const projectEntries = await this.projectStore.getAll();
      projectEntry = projectEntries.find(
        e => e.projectPath === projectPath
      ) ?? projectEntries[0] ?? null;
    }

    // Score all candidates
    const scored = candidates
      .map(entry => ({
        entry,
        score: this.scoreEntry(entry, queryTokens),
      }))
      .filter(s => s.score >= threshold);

    // Sort by score descending
    const sorted = scored.sort((a, b) => b.score - a.score);

    // Take top N
    const results = sorted.slice(0, limit).map(s => s.entry);

    // Prepend project memory if it exists
    if (projectEntry) {
      return [projectEntry, ...results];
    }

    return results;
  }

  private tokenize(text: string): string[] {
    // Split into tokens:
    // - Keep English words (a-z0-9) as-is
    // - Split Chinese into individual characters (each char is a "token")
    // - Remove very short tokens
    const tokens: string[] = [];
    const regex = /([a-z0-9]{2,})|([\u4e00-\u9fa5])/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match[1]) {
        tokens.push(match[1]);
      } else if (match[2]) {
        tokens.push(match[2]);
      }
    }
    return [...new Set(tokens)];
  }

  private scoreEntry(entry: MemoryEntry, queryTokens: string[]): number {
    const entryTextTokens = this.tokenize(entry.text.toLowerCase());
    const entryTags = entry.tags?.map(t => t.toLowerCase()) ?? [];

    // Keyword match score: 0.4 weight
    const keywordMatches = queryTokens.filter(t =>
      entryTextTokens.some(et => et.includes(t) || t.includes(et))
    ).length;
    const keywordScore = keywordMatches / Math.max(queryTokens.length, 1);

    // Tag match score: 0.3 weight
    const tagMatches = queryTokens.filter(t =>
      entryTags.some(et => et.includes(t) || t.includes(et))
    ).length;
    const tagScore = queryTokens.length > 0
      ? tagMatches / Math.max(queryTokens.length, 1)
      : 0;

    // If no matches at all, score 0 to get filtered out
    if (keywordMatches === 0 && tagMatches === 0) {
      return 0;
    }

    // Recency score: 0.2 weight
    const ageMs = Date.now() - new Date(entry.created).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    // Exponential decay: 1.0 for today, 0.5 after 30 days, ~0 after a year
    const recencyScore = Math.exp(-ageDays / 30);

    // Weight score: 0.1 weight
    const weightScore = entry.weight;

    return (
      keywordScore * 0.4 +
      tagScore * 0.3 +
      recencyScore * 0.2 +
      weightScore * 0.1
    );
  }
}
