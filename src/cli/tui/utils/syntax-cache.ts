import type { LineToken } from '../components/utils/tokenize-by-line';

const CACHE_MAX_SIZE = 50;
const SYNTAX_CACHE_KEY_PREVIEW_LENGTH = 64;
const cache = new Map<string, LineToken[][]>();

function makeCacheKey(content: string, lang: string): string {
  const preview = content.slice(0, SYNTAX_CACHE_KEY_PREVIEW_LENGTH).replace(/\n/g, '\\n');
  return `${lang}:${content.length}:${preview}`;
}

export function getCachedTokens(content: string, lang: string): LineToken[][] | undefined {
  const key = makeCacheKey(content, lang);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  return undefined;
}

export function setCachedTokens(content: string, lang: string, tokens: LineToken[][]): void {
  const key = makeCacheKey(content, lang);
  cache.set(key, tokens);

  if (cache.size > CACHE_MAX_SIZE) {
    const firstKey = cache.keys().next().value as string;
    cache.delete(firstKey);
  }
}
