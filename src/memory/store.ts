import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { MemoryEntry, MemoryStore, MemoryType, MemoryConfig } from './types';
import { DEFAULT_MEMORY_CONFIG } from './types';

export class JsonlMemoryStore implements MemoryStore {
  private filePath: string;
  private cache: MemoryEntry[] | null = null;
  private type: MemoryType;
  private config: Required<MemoryConfig>;

  constructor(
    type: MemoryType,
    config: MemoryConfig = {},
    projectPath?: string,
  ) {
    this.type = type;
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };

    if (type === 'project' && projectPath) {
      // Project memory: local to project .claude/ directory
      this.filePath = path.join(projectPath, '.claude', 'memory-project.json');
    } else {
      // Global memory: semantic and episodic
      const baseDir = this.expandBaseDir(this.config.globalBaseDir);
      this.filePath = path.join(baseDir, `${type}.jsonl`);
    }
  }

  private expandBaseDir(baseDir: string): string {
    if (baseDir.startsWith('~')) {
      return path.join(os.homedir(), baseDir.slice(1));
    }
    return baseDir;
  }

  private async ensureDir(): Promise<void> {
    const dir = path.dirname(this.filePath);
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  private invalidateCache(): void {
    this.cache = null;
  }

  async add(entry: Omit<MemoryEntry, 'id' | 'created'>): Promise<MemoryEntry> {
    await this.ensureDir();

    const fullEntry: MemoryEntry = {
      ...entry,
      id: crypto.randomUUID(),
      created: new Date().toISOString(),
    };

    const content = JSON.stringify(fullEntry);

    if (this.type === 'project') {
      // Project memory is single JSON file, not JSONL
      await fs.writeFile(this.filePath, JSON.stringify(fullEntry, null, 2), 'utf8');
    } else {
      // Append to JSONL
      await fs.appendFile(this.filePath, content + '\n', 'utf8');
    }

    this.invalidateCache();

    // Check if we need to trigger FIFO trimming
    const count = await this.count();
    const maxEntries = this.type === 'semantic'
      ? this.config.maxSemanticEntries
      : this.config.maxEpisodicEntries;

    if (count > maxEntries) {
      await this.trimFifo(maxEntries);
    }

    return fullEntry;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const all = await this.getAll();
    return all.find(e => e.id === id) ?? null;
  }

  async update(id: string, patch: Partial<MemoryEntry>): Promise<MemoryEntry | null> {
    const all = await this.getAll();
    const index = all.findIndex(e => e.id === id);
    if (index === -1) return null;

    all[index] = { ...all[index], ...patch, updated: new Date().toISOString() };
    await this.replaceAll(all, this.type);
    return all[index];
  }

  async remove(id: string): Promise<boolean> {
    const all = await this.getAll();
    const initialLength = all.length;
    const filtered = all.filter(e => e.id !== id);
    if (filtered.length === initialLength) return false;

    await this.replaceAll(filtered, this.type);
    return true;
  }

  async getAll(): Promise<MemoryEntry[]> {
    if (this.cache !== null) {
      return this.cache;
    }

    try {
      await fs.access(this.filePath);
    } catch {
      this.cache = [];
      return [];
    }

    if (this.type === 'project') {
      const content = await fs.readFile(this.filePath, 'utf8');
      const entry = JSON.parse(content) as MemoryEntry;
      this.cache = [entry];
      return this.cache;
    }

    const content = await fs.readFile(this.filePath, 'utf8');
    const lines = content.split('\n').filter((line: string) => line.trim());
    const entries = lines.map((line: string) => JSON.parse(line) as MemoryEntry);
    this.cache = entries;
    return entries;
  }

  async getByType(type: MemoryType): Promise<MemoryEntry[]> {
    const all = await this.getAll();
    return all.filter(e => e.type === type);
  }

  async replaceAll(entries: MemoryEntry[], type: MemoryType): Promise<void> {
    await this.ensureDir();

    if (type === 'project') {
      if (entries.length > 0) {
        await fs.writeFile(this.filePath, JSON.stringify(entries[0], null, 2), 'utf8');
      }
    } else {
      const content = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
      await fs.writeFile(this.filePath, content, 'utf8');
    }

    this.cache = [...entries];
  }

  async count(type?: MemoryType): Promise<number> {
    const all = await this.getAll();
    if (type) {
      return all.filter(e => e.type === type).length;
    }
    return all.length;
  }

  async getRecent(limit: number, type?: MemoryType): Promise<MemoryEntry[]> {
    let all = await this.getAll();
    if (type) {
      all = all.filter(e => e.type === type);
    }
    // Sort by created date descending
    return all
      .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
      .slice(0, limit);
  }

  private async trimFifo(maxEntries: number): Promise<void> {
    const all = await this.getAll();
    // Keep newest entries, remove oldest
    const trimmed = all
      .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
      .slice(0, maxEntries);
    await this.replaceAll(trimmed, this.type);
  }
}
