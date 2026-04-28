import type { Message, CompressionStrategy, Provider } from '../../types';

// --- Backward compatibility: Old type definitions for existing code ---
export type CompactionLevelType = 'none' | 'snip' | 'tool-shrink' | 'summarize' | 'reactive';

export interface CompactionResult {
  messages: Message[];
  level: CompactionLevelType;
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
  // New fields added for compatibility with redesigned system
  tier?: 0 | 1 | 2 | 3 | 4;
  summary?: string;
  needsContinuation?: boolean;
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

// --- New type definitions for redesigned tiered system ---
/** Token budget calculation result */
export interface TokenBudget {
  /** Model's absolute max context window */
  modelLimit: number;
  /** Reserved for LLM output generation */
  maxOutputTokens: number;
  /** Buffer for compaction overhead (LLM summary generation itself consumes tokens) */
  compactionBuffer: number;
  /** modelLimit - maxOutputTokens - compactionBuffer */
  effectiveLimit: number;
  /** Current token usage (messages + systemPrompt + tool_calls) */
  currentUsage: number;
  /** currentUsage / effectiveLimit */
  usageRatio: number;
}

/** Thresholds for triggering each compaction tier */
export interface CompactionThresholds {
  /** Tier 1: snip tool outputs (default: 0.60) */
  snipRatio: number;
  /** Tier 2: LLM summarization (default: 0.75) */
  autoCompactRatio: number;
  /** Tier 4: context collapse (default: 0.90) */
  collapseRatio: number;
  /** Max chars for a single tool output before snip considers it (default: 8000) */
  toolOutputSnipThreshold: number;
  /** Number of recent turns to always preserve (default: 4, i.e. 2 user-assistant pairs) */
  preserveRecentTurns: number;
}

/** Result of a compaction operation */
export interface NewCompactionResult {
  /** New message array after compaction */
  messages: Message[];
  /** Which tier was applied */
  tier: 0 | 1 | 2 | 3 | 4;
  /** Token count before compaction */
  tokensBefore: number;
  /** Token count after compaction */
  tokensAfter: number;
  /** Human-readable summary of what was compacted (for continuation message) */
  summary?: string;
  /** Whether a continuation message should be injected */
  needsContinuation: boolean;
}

/** Configuration for the compaction system */
export interface CompactionConfig {
  thresholds: CompactionThresholds;
  /** Provider used for Tier 2 LLM summarization (can be a cheaper/faster model) */
  summaryProvider?: Provider;
  /** Model override for summary generation (e.g., 'claude-3-haiku') */
  summaryModel?: string;
  /** Max tokens for the generated summary (default: 1024) */
  maxSummaryTokens: number;
  /** Enable/disable individual tiers */
  enabledTiers: {
    snip: boolean;
    autoCompact: boolean;
    reactiveRecovery: boolean;
    collapse: boolean;
  };
}

export const DEFAULT_COMPACTION_THRESHOLDS: CompactionThresholds = {
  snipRatio: 0.60,
  autoCompactRatio: 0.75,
  collapseRatio: 0.90,
  toolOutputSnipThreshold: 8000,
  preserveRecentTurns: 4,
};

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  thresholds: DEFAULT_COMPACTION_THRESHOLDS,
  maxSummaryTokens: 1024,
  enabledTiers: {
    snip: true,
    autoCompact: true,
    reactiveRecovery: true,
    collapse: true,
  },
};
