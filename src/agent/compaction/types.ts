import type { Message, CompressionStrategy } from '../../types';

export type CompactionLevelType = 'none' | 'snip' | 'tool-shrink' | 'summarize' | 'reactive';

export interface CompactionResult {
  messages: Message[];
  level: CompactionLevelType;
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
}

export interface CompactionLevel {
  name: CompactionLevelType;
  triggerAt: number; // usage ratio threshold to trigger
  strategy?: CompressionStrategy;
}

export interface TieredCompactionConfig {
  levels: CompactionLevel[];
}

export const DEFAULT_TIERED_LEVELS: CompactionLevel[] = [
  { name: 'snip', triggerAt: 0.60 },
  { name: 'tool-shrink', triggerAt: 0.75 },
  { name: 'summarize', triggerAt: 0.85 },
];
