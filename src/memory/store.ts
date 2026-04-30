import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { MemoryEntry, MemoryStore, MemoryType, MemoryConfig } from './types';
import { getSettingsSync } from '../config';

// Fallback defaults if settings aren't loaded yet
const FALLBACK_MEMORY_CONFIG: Required<MemoryConfig> = {
  globalBaseDir: '~/.my-agent/memory',
  maxSemanticEntries: 200,
  maxEpisodicEntries: 500,
  consolidationThreshold: 50,
  autoExtractMinToolCalls: 3,
  maxInjectedEntries: 10,
  extractionModel: 'claude-3-haiku-20240307',
  retrievalThreshold: 0.75,
  retrievalTopK: 5,
  extractTriggerMode: 'explicit',
  maxUserPreferences: 20,
};

// Get settings with fallback
function getMemoryConfig(): Required<MemoryConfig> {
  try {
    const settings = getSettingsSync();
    return settings.memory as unknown as Required<MemoryConfig>;
  } catch {
    return FALLBACK_MEMORY_CONFIG;
  }
}

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
    // Merge any explicit config overrides with centralized settings (or fallback)
    this.config = { ...getMemoryConfig(), ...config };

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

    if (this.type === 'project') {
      // Project memory stores an array of entries
      const existingEntries = await this.getAll();
      const updatedEntries = [...existingEntries, fullEntry];
      await fs.writeFile(this.filePath, JSON.stringify(updatedEntries, null, 2), 'utf8');
    } else {
      // Append to JSONL
      const content = JSON.stringify(fullEntry);
      await fs.appendFile(this.filePath, content + '\n', 'utf8');
    }

    // Check if we need to trigger FIFO trimming
    const count = await this.count();
    const maxEntries = this.type === 'semantic'
      ? this.config.maxSemanticEntries
      : this.config.maxEpisodicEntries;

    if (count > maxEntries) {
      await this.trimFifo(maxEntries);
    }

    this.invalidateCache();

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

    all[index] = { ...all[index], ...patch, updated: new Date().toISOString() } as MemoryEntry;
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
      const entries = JSON.parse(content) as MemoryEntry[];
      this.cache = entries;
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

  async replaceAll(entries: MemoryEntry[], _type: MemoryType): Promise<void> {
    await this.ensureDir();

    if (this.type === 'project') {
      await fs.writeFile(this.filePath, JSON.stringify(entries, null, 2), 'utf8');
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
    // Preserve original indices for tiebreaking
    const entriesWithIndices = all.map((entry, index) => ({ entry, index }));
    const sorted = entriesWithIndices.sort((a, b) => {
      const aTime = new Date(a.entry.created).getTime();
      const bTime = new Date(b.entry.created).getTime();
      if (bTime !== aTime) {
        return bTime - aTime;
      }
      // If timestamps are equal, later entries (higher index) come first
      return b.index - a.index;
    });
    return sorted.slice(0, limit).map(item => item.entry);
  }

  private async trimFifo(maxEntries: number): Promise<void> {
    const all = await this.getAll();
    // Keep newest entries, remove oldest
    // Preserve original indices for tiebreaking
    const entriesWithIndices = all.map((entry, index) => ({ entry, index }));
    const sorted = entriesWithIndices.sort((a, b) => {
      const aTime = new Date(a.entry.created).getTime();
      const bTime = new Date(b.entry.created).getTime();
      if (bTime !== aTime) {
        return bTime - aTime;
      }
      // If timestamps are equal, later entries (higher index) come first
      return b.index - a.index;
    });
    const trimmed = sorted.slice(0, maxEntries).map(item => item.entry);
    await this.replaceAll(trimmed, this.type);
  }

  /**
   * Evict entries exceeding capacity, preferring to keep recently-hit entries.
   * Uses lastHitAt as primary sort, falling back to created date.
   */
  async enforceLimit(): Promise<void> {
    const all = await this.getAll();
    const maxEntries = this.type === 'semantic'
      ? this.config.maxSemanticEntries
      : this.config.maxEpisodicEntries;

    if (all.length <= maxEntries) return;

    const sorted = all.sort((a, b) => {
      const aTime = a.lastHitAt ?? new Date(a.created).getTime();
      const bTime = b.lastHitAt ?? new Date(b.created).getTime();
      return bTime - aTime; // descending: most recent first
    });
    const kept = sorted.slice(0, maxEntries);
    await this.replaceAll(kept, this.type);
  }

  /**
   * Mark entries as retrieved by updating lastHitAt and usageCount.
   * Called after episodic recall to feed LRU eviction.
   */
  async markHit(ids: string[]): Promise<void> {
    const idSet = new Set(ids);
    const all = await this.getAll();
    let changed = false;
    const now = Date.now();
    for (const entry of all) {
      if (idSet.has(entry.id)) {
        entry.lastHitAt = now;
        entry.usageCount = (entry.usageCount ?? 0) + 1;
        changed = true;
      }
    }
    if (changed) {
      await this.replaceAll(all, this.type);
    }
  }
}
