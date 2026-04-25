import { describe, it, expect, vi, beforeEach } from 'bun:test';
import type { MemoryEntry, MemoryStore, MemoryRetriever, MemoryExtractor } from '../../src/memory/types';
import { MemoryTool } from '../../src/memory/tool';
import { createTestCtx } from '../agent/tool-dispatch/test-helpers';

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
  add = vi.fn().mockImplementation(e => Promise.resolve({ ...e, id: 'mock-id', created: new Date().toISOString() }));
  get = vi.fn().mockResolvedValue(null);
  remove = vi.fn().mockResolvedValue(false);
  getAll = vi.fn().mockImplementation(() => Promise.resolve(this.entries));
  getRecent = vi.fn().mockImplementation((limit) => Promise.resolve(this.entries.slice(0, limit)));
  replaceAll = vi.fn().mockResolvedValue(undefined);
}

class MockRetriever implements Partial<MemoryRetriever> {
  results: MemoryEntry[] = [];
  search = vi.fn().mockImplementation(() => Promise.resolve(this.results));
}

class MockExtractor implements Partial<MemoryExtractor> {
  consolidateResult: MemoryEntry[] = [];
  extract = vi.fn().mockResolvedValue([]);
  consolidate = vi.fn().mockImplementation(() => Promise.resolve(this.consolidateResult));
}

describe('MemoryTool', () => {
  let tool: MemoryTool;
  let stores: {
    semantic: MockMemoryStore;
    episodic: MockMemoryStore;
    project: MockMemoryStore;
  };
  let mockRetriever: MockRetriever;
  let mockExtractor: MockExtractor;

  beforeEach(() => {
    stores = {
      semantic: new MockMemoryStore(),
      episodic: new MockMemoryStore(),
      project: new MockMemoryStore(),
    };
    mockRetriever = new MockRetriever();
    mockExtractor = new MockExtractor();
    tool = new MemoryTool(
      stores as any,
      mockRetriever as any,
      mockExtractor as any,
    );
  });

  describe('search', () => {
    it('calls retriever.search and returns results', async () => {
      mockRetriever.results = [makeEntry({ text: 'found' })];
      const result = await tool.execute({ command: 'search', query: 'test' }, createTestCtx());
      expect(mockRetriever.search).toHaveBeenCalled();
      expect(result).toEqual({ results: expect.arrayContaining([expect.objectContaining({ text: 'found' })]) });
    });

    it('throws when query is missing', async () => {
      await expect(tool.execute({ command: 'search' }, createTestCtx())).rejects.toThrow('query parameter is required');
    });
  });

  describe('add', () => {
    it('adds to semantic store by default', async () => {
      const addSpy = vi.spyOn(stores.semantic, 'add');
      await tool.execute({ command: 'add', text: 'new fact' }, createTestCtx());
      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'semantic',
        text: 'new fact',
        weight: 1.0,
        source: 'explicit',
      }));
    });

    it('adds to project store when type=project specified, includes projectPath', async () => {
      const addSpy = vi.spyOn(stores.project, 'add');
      await tool.execute({ command: 'add', text: 'uses bun', type: 'project' }, createTestCtx());
      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'project',
        projectPath: expect.any(String),
      }));
    });

    it('throws when text is missing', async () => {
      await expect(tool.execute({ command: 'add' }, createTestCtx())).rejects.toThrow('text parameter is required');
    });
  });

  describe('list', () => {
    it('without type filter → gets recent from all three stores, merged', async () => {
      stores.semantic.entries = [makeEntry({ type: 'semantic', text: 'sem' })];
      stores.episodic.entries = [makeEntry({ type: 'episodic', text: 'epi' })];
      stores.project.entries = [makeEntry({ type: 'project', text: 'proj' })];

      const result = await tool.execute({ command: 'list', limit: 10 }, createTestCtx()) as any;
      expect(result.entries).toHaveLength(3);
    });

    it('type=semantic → gets only from semantic store', async () => {
      stores.semantic.entries = [makeEntry({ type: 'semantic', text: 'sem' })];
      stores.episodic.entries = [makeEntry({ type: 'episodic', text: 'epi' })];

      const result = await tool.execute({ command: 'list', type: 'semantic' }, createTestCtx()) as any;
      expect(result.entries.every((e: any) => e.type === 'semantic')).toBe(true);
    });
  });

  describe('forget', () => {
    it('searches all stores until found and deleted', async () => {
      const entry = makeEntry({ type: 'episodic', text: 'to delete' });
      stores.episodic.entries = [entry];
      vi.spyOn(stores.episodic, 'remove').mockResolvedValue(true);

      const result = await tool.execute({ command: 'forget', id: entry.id }, createTestCtx()) as any;
      expect(result.deleted).toBe(true);
      expect(result.type).toBe('episodic');
    });

    it('returns deleted: false when not found in any store', async () => {
      const result = await tool.execute({ command: 'forget', id: 'nonexistent' }, createTestCtx()) as any;
      expect(result.deleted).toBe(false);
    });

    it('throws when id is missing', async () => {
      await expect(tool.execute({ command: 'forget' }, createTestCtx())).rejects.toThrow('id parameter is required');
    });
  });

  describe('consolidate', () => {
    it('calls extractor.consolidate and replaces semantic store', async () => {
      stores.semantic.entries = [
        makeEntry({ text: 'dup 1' }),
        makeEntry({ text: 'dup 2' }),
      ];
      mockExtractor.consolidateResult = [makeEntry({ text: 'merged' })];

      const result = await tool.execute({ command: 'consolidate' }, createTestCtx()) as any;
      expect(result.before).toBe(2);
      expect(result.after).toBe(1);
      expect(result.removed).toBe(1);
      expect(stores.semantic.replaceAll).toHaveBeenCalled();
    });

    it('returns 0/0/0 when semantic store is empty', async () => {
      const result = await tool.execute({ command: 'consolidate' }, createTestCtx()) as any;
      expect(result).toEqual({ before: 0, after: 0, removed: 0 });
    });
  });

  it('throws validation error on unknown command', async () => {
    await expect(
      tool.execute({ command: 'invalid' }, createTestCtx()),
    ).rejects.toThrow('Parameter validation failed');
  });
});
