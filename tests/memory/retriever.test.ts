import { describe, it, expect, vi, beforeEach } from 'bun:test';
import type { MemoryEntry, MemoryStore } from '../../src/memory/types';
import { KeywordRetriever } from '../../src/memory/retriever';

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'test-id',
    type: 'semantic',
    text: 'test',
    weight: 1,
    source: 'explicit',
    created: new Date().toISOString(),
    ...overrides,
  };
}

class MockMemoryStore implements Partial<MemoryStore> {
  entries: MemoryEntry[] = [];
  getAll = vi.fn().mockImplementation(() => Promise.resolve(this.entries));
}

describe('KeywordRetriever', () => {
  let semanticStore: MockMemoryStore;
  let episodicStore: MockMemoryStore;
  let projectStore: MockMemoryStore;
  let retriever: KeywordRetriever;

  beforeEach(() => {
    semanticStore = new MockMemoryStore();
    episodicStore = new MockMemoryStore();
    projectStore = new MockMemoryStore();
    retriever = new KeywordRetriever(
      semanticStore as any,
      episodicStore as any,
      projectStore as any,
    );
  });

  it('exact keyword match gets high score', async () => {
    semanticStore.entries = [
      makeEntry({ text: 'user prefers vitest over jest', type: 'semantic' }),
      makeEntry({ text: 'project uses react', type: 'semantic' }),
    ];
    const results = await retriever.search('vitest');
    expect(results[0].text).toContain('vitest');
  });

  it('tag match increases score', async () => {
    semanticStore.entries = [
      makeEntry({ text: 'some fact', tags: ['typescript', 'testing'], type: 'semantic' }),
      makeEntry({ text: 'typescript is used', type: 'semantic' }),
    ];
    const results = await retriever.search('testing');
    expect(results[0].tags).toContain('testing');
  });

  it('more recent memories get higher score (recency decay)', async () => {
    semanticStore.entries = [
      makeEntry({ text: 'prefers pnpm', created: '2020-01-01T00:00:00Z', type: 'semantic' }),
      makeEntry({ text: 'prefers pnpm (confirmed)', created: new Date().toISOString(), type: 'semantic' }),
    ];
    const results = await retriever.search('pnpm');
    expect(new Date(results[0].created).getTime())
      .toBeGreaterThan(new Date(results[1].created).getTime());
  });

  it('higher weight gets higher score', async () => {
    semanticStore.entries = [
      makeEntry({ text: 'uses bun', weight: 0.3, type: 'semantic' }),
      makeEntry({ text: 'uses bun runtime', weight: 1.0, type: 'semantic' }),
    ];
    const results = await retriever.search('bun');
    expect(results[0].weight).toBe(1.0);
  });

  it('no matches → empty array', async () => {
    semanticStore.entries = [
      makeEntry({ text: 'completely unrelated content', type: 'semantic' }),
    ];
    const results = await retriever.search('typescript vitest');
    expect(results).toHaveLength(0);
  });

  it('limit parameter restricts number of results', async () => {
    semanticStore.entries = Array(20).fill(null).map((_, i) =>
      makeEntry({ text: `fact about typescript ${i}`, type: 'semantic' })
    );
    const results = await retriever.search('typescript', { limit: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });
});

describe('Tokenizer', () => {
  let semanticStore: MockMemoryStore;
  let episodicStore: MockMemoryStore;
  let projectStore: MockMemoryStore;
  let retriever: KeywordRetriever;

  beforeEach(() => {
    semanticStore = new MockMemoryStore();
    episodicStore = new MockMemoryStore();
    projectStore = new MockMemoryStore();
    retriever = new KeywordRetriever(
      semanticStore as any,
      episodicStore as any,
      projectStore as any,
    );
  });

  it('splits Chinese into individual characters', async () => {
    semanticStore.entries = [
      makeEntry({ text: '用户偏好暗色主题', type: 'semantic' }),
    ];
    const results = await retriever.search('暗色主题');
    expect(results).toHaveLength(1);
  });

  it('English matches whole words, filters out single letters', () => {
    const tokens = (retriever as any).tokenize('a b');
    expect(tokens).toHaveLength(0); // length < 2 filtered out
  });

  it('handles mixed Chinese and English correctly', async () => {
    semanticStore.entries = [
      makeEntry({ text: '项目使用 vitest 做测试', type: 'semantic' }),
    ];
    const results = await retriever.search('vitest 测试');
    expect(results).toHaveLength(1);
  });
});

describe('Cross-store search', () => {
  let semanticStore: MockMemoryStore;
  let episodicStore: MockMemoryStore;
  let projectStore: MockMemoryStore;
  let retriever: KeywordRetriever;

  beforeEach(() => {
    semanticStore = new MockMemoryStore();
    episodicStore = new MockMemoryStore();
    projectStore = new MockMemoryStore();
    retriever = new KeywordRetriever(
      semanticStore as any,
      episodicStore as any,
      projectStore as any,
    );
  });

  it('searches both semantic + episodic', async () => {
    semanticStore.entries = [makeEntry({ text: 'prefers dark mode', type: 'semantic' })];
    episodicStore.entries = [makeEntry({ text: 'changed to dark mode yesterday', type: 'episodic' })];

    const results = await retriever.search('dark mode');
    expect(results).toHaveLength(2);
  });

  it('when projectPath exists, project memory is prepended as first result', async () => {
    projectStore.entries = [
      makeEntry({ type: 'project', text: 'monorepo with packages/', projectPath: '/my/project' }),
    ];
    semanticStore.entries = [makeEntry({ text: 'uses typescript', type: 'semantic' })];

    const results = await retriever.search('project structure', { projectPath: '/my/project' });
    expect(results[0].type).toBe('project');
  });

  it('does not match entries with undefined projectPath when query has specific projectPath', async () => {
    // This tests the bug fix: previously any entry with projectPath: undefined would match
    projectStore.entries = [
      makeEntry({ type: 'project', text: 'global project note', projectPath: undefined }),
      makeEntry({ type: 'project', text: 'correct project', projectPath: '/my/project' }),
    ];

    const results = await retriever.search('test', { projectPath: '/my/project' });
    // Should find the correct one, not the undefined one
    expect(results[0].text).toBe('correct project');
  });
});
