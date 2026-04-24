import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { JsonlMemoryStore } from '../../src/memory/store';
import type { MemoryEntry } from '../../src/memory/types';

describe('JsonlMemoryStore', () => {
  let store: JsonlMemoryStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-test-'));
    store = new JsonlMemoryStore('semantic', { globalBaseDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it('add → returns complete entry with id and created', async () => {
    const entry = await store.add({
      type: 'semantic',
      text: 'user prefers vim',
      weight: 0.9,
      source: 'explicit',
    });
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/); // UUID
    expect(entry.created).toBeTruthy();
    expect(entry.text).toBe('user prefers vim');
  });

  it('add → getAll finds all entries', async () => {
    await store.add({ type: 'semantic', text: 'fact A', weight: 1, source: 'explicit' });
    await store.add({ type: 'semantic', text: 'fact B', weight: 1, source: 'explicit' });
    const all = await store.getAll();
    expect(all).toHaveLength(2);
  });

  it('get by id', async () => {
    const added = await store.add({ type: 'semantic', text: 'test', weight: 1, source: 'explicit' });
    const found = await store.get(added.id);
    expect(found).toEqual(added);
  });

  it('get nonexistent id → null', async () => {
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('update modifies text and weight', async () => {
    const added = await store.add({ type: 'semantic', text: 'old', weight: 0.5, source: 'explicit' });
    const updated = await store.update(added.id, { text: 'new', weight: 0.9 });
    expect(updated!.text).toBe('new');
    expect(updated!.weight).toBe(0.9);
    expect(updated!.updated).toBeTruthy();
  });

  it('update nonexistent id → null', async () => {
    expect(await store.update('nonexistent', { text: 'x' })).toBeNull();
  });

  it('remove → get returns null after', async () => {
    const added = await store.add({ type: 'semantic', text: 'temp', weight: 1, source: 'explicit' });
    expect(await store.remove(added.id)).toBe(true);
    expect(await store.get(added.id)).toBeNull();
  });

  it('remove nonexistent id → false', async () => {
    expect(await store.remove('nonexistent')).toBe(false);
  });

  it('count gives accurate count', async () => {
    await store.add({ type: 'semantic', text: 'a', weight: 1, source: 'explicit' });
    await store.add({ type: 'semantic', text: 'b', weight: 1, source: 'explicit' });
    expect(await store.count()).toBe(2);
  });
});

describe('Storage format', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it('semantic store uses JSONL format (one JSON per line)', async () => {
    const store = new JsonlMemoryStore('semantic', { globalBaseDir: tmpDir });
    await store.add({ type: 'semantic', text: 'a', weight: 1, source: 'explicit' });
    await store.add({ type: 'semantic', text: 'b', weight: 1, source: 'explicit' });

    const content = await fs.readFile(path.join(tmpDir, 'semantic.jsonl'), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    // Each line is valid JSON
    lines.forEach(line => expect(() => JSON.parse(line)).not.toThrow());
  });

  it('project store uses JSON array format', async () => {
    const store = new JsonlMemoryStore('project', {}, tmpDir);
    await store.add({ type: 'project', text: 'uses bun', weight: 1, source: 'explicit' });

    const content = await fs.readFile(
      path.join(tmpDir, '.claude', 'memory-project.json'), 'utf8'
    );
    const parsed = JSON.parse(content);
    expect(Array.isArray(parsed)).toBe(true);
  });
});

describe('FIFO trimming', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it('deletes oldest entries when exceeding maxSemanticEntries', async () => {
    const store = new JsonlMemoryStore('semantic', {
      globalBaseDir: tmpDir,
      maxSemanticEntries: 5,
    });

    // Add 7 entries with small delay to ensure distinct timestamps
    for (let i = 0; i < 7; i++) {
      await store.add({ type: 'semantic', text: `fact ${i}`, weight: 1, source: 'explicit' });
      // Add 1ms delay to ensure each entry has a distinct created time
      await new Promise(resolve => setTimeout(resolve, 1));
    }

    const all = await store.getAll();
    expect(all).toHaveLength(5);
    // Keep newest 5 (fact 2~6)
    const texts = all.map(e => e.text);
    expect(texts).not.toContain('fact 0');
    expect(texts).not.toContain('fact 1');
    expect(texts).toContain('fact 6');
  });

  it('episodic store uses maxEpisodicEntries limit', async () => {
    const store = new JsonlMemoryStore('episodic', {
      globalBaseDir: tmpDir,
      maxEpisodicEntries: 3,
    });
    for (let i = 0; i < 5; i++) {
      await store.add({ type: 'episodic', text: `event ${i}`, weight: 1, source: 'implicit' });
    }
    expect(await store.count()).toBe(3);
  });
});

describe('Cache consistency', () => {
  let tmpDir: string;
  let store: JsonlMemoryStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-test-'));
    store = new JsonlMemoryStore('semantic', { globalBaseDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it('getAll does not return stale cache after add', async () => {
    const all1 = await store.getAll(); // fills cache
    await store.add({ type: 'semantic', text: 'new', weight: 1, source: 'explicit' });
    const all2 = await store.getAll();
    expect(all2.length).toBe(all1.length + 1);
  });

  it('getAll does not return deleted entries after remove', async () => {
    const added = await store.add({ type: 'semantic', text: 'x', weight: 1, source: 'explicit' });
    await store.getAll(); // fill cache
    await store.remove(added.id);
    const all = await store.getAll();
    expect(all.find(e => e.id === added.id)).toBeUndefined();
  });

  it('replaceAll completely replaces cache', async () => {
    await store.add({ type: 'semantic', text: 'old', weight: 1, source: 'explicit' });
    const newEntries: MemoryEntry[] = [{
      id: 'x',
      type: 'semantic',
      text: 'replaced',
      weight: 1,
      source: 'explicit',
      created: new Date().toISOString(),
    }];
    await store.replaceAll(newEntries, 'semantic');
    const all = await store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].text).toBe('replaced');
  });
});

describe('Edge cases', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it('getAll returns empty array when file does not exist', async () => {
    const store = new JsonlMemoryStore('semantic', { globalBaseDir: tmpDir });
    expect(await store.getAll()).toEqual([]);
  });

  it('empty lines in JSONL file → skipped without error', async () => {
    const filePath = path.join(tmpDir, 'semantic.jsonl');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath,
      '{"id":"1","type":"semantic","text":"a","weight":1,"source":"explicit","created":"2024-01-01"}\n\n\n', 'utf8'
    );

    const store = new JsonlMemoryStore('semantic', { globalBaseDir: tmpDir });
    const all = await store.getAll();
    expect(all).toHaveLength(1);
  });

  it('~ path expands to homedir', () => {
    const store = new JsonlMemoryStore('semantic', { globalBaseDir: '~/.my-agent/memory' });
    const filePath = (store as any).filePath as string;
    expect(filePath).toContain(os.homedir());
  });

  it('getRecent returns sorted by created descending', async () => {
    const store = new JsonlMemoryStore('semantic', { globalBaseDir: tmpDir });
    const e1 = await store.add({ type: 'semantic', text: 'old', weight: 1, source: 'explicit' });
    // Manually set earlier time
    await store.update(e1.id, { created: '2020-01-01T00:00:00Z' } as any);
    const e2 = await store.add({ type: 'semantic', text: 'new', weight: 1, source: 'explicit' });

    const recent = await store.getRecent(2);
    expect(recent[0].text).toBe('new');
  });
});
