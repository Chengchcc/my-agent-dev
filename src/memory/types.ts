import type { Message } from '../types';

export type MemoryType = 'semantic' | 'episodic' | 'project';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  text: string;
  tags?: string[];
  created: string;
  updated?: string;
  weight: number;
  source: 'explicit' | 'implicit' | 'user';
  projectPath?: string;
  files?: string[];
  metadata?: Record<string, unknown>;
}

export interface MemoryStore {
  add(entry: Omit<MemoryEntry, 'id' | 'created'>): Promise<MemoryEntry>;
  get(id: string): Promise<MemoryEntry | null>;
  update(id: string, patch: Partial<MemoryEntry>): Promise<MemoryEntry | null>;
  remove(id: string): Promise<boolean>;
  getAll(): Promise<MemoryEntry[]>;
  getByType(type: MemoryType): Promise<MemoryEntry[]>;
  replaceAll(entries: MemoryEntry[], type: MemoryType): Promise<void>;
  count(type?: MemoryType): Promise<number>;
  getRecent(limit: number, type?: MemoryType): Promise<MemoryEntry[]>;
}

export interface MemoryRetriever {
  search(query: string, options?: { limit?: number; projectPath?: string }): Promise<MemoryEntry[]>;
}

export interface MemoryExtractor {
  extract(messages: Message[], projectPath?: string): Promise<MemoryEntry[]>;
  consolidate(entries: MemoryEntry[]): Promise<MemoryEntry[]>;
}

export interface MemoryConfig {
  globalBaseDir?: string;
  maxSemanticEntries?: number;
  maxEpisodicEntries?: number;
  consolidationThreshold?: number;
  autoExtractMinToolCalls?: number;
  maxInjectedEntries?: number;
  extractionModel?: string;
}

