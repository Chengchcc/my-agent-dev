import type { Message, Provider } from '../../types';

export type CompactionLevelType = 'none' | 'snip' | 'tool-shrink' | 'summarize' | 'reactive' | 'collapse';

export const CompactionTier = {
  None: 0,
  Snip: 1,
  AutoCompact: 2,
  Reactive: 3,
  Collapse: 4,
} as const;

export type CompactionTierNumber = (typeof CompactionTier)[keyof typeof CompactionTier];

export interface CompactionResult {
  messages: Message[];
  level: CompactionLevelType;
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
  tier?: CompactionTierNumber;
  summary?: string;
  needsContinuation?: boolean;
}
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
