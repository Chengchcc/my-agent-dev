import type { Settings } from './types';
import {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_SUMMARY_MODEL,
  DEFAULT_MAX_SUMMARY_TOKENS,
  DEFAULT_TOKEN_LIMIT,
} from './constants';

export const defaultSettings: Settings = {
  llm: {
    provider: 'claude',
    model: DEFAULT_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: DEFAULT_TEMPERATURE,
    apiKey: null,
    baseURL: null,
  },
  context: {
    tokenLimit: DEFAULT_TOKEN_LIMIT,
    budgetGuard: {
      enabled: true,
      delegateThreshold: 0.30,
      compactThreshold: 0.15,
      batchOutputRatio: 0.60,
      minReadCallsForBatch: 3,
    },
    compaction: {
      enabled: true,
      snipRatio: 0.60,
      autoCompactRatio: 0.75,
      collapseRatio: 0.90,
      toolOutputSnipThreshold: 8000,
      preserveRecentTurns: 4,
      summaryModel: DEFAULT_SUMMARY_MODEL,
      maxSummaryTokens: DEFAULT_MAX_SUMMARY_TOKENS,
      enabledTiers: {
        snip: true,
        autoCompact: true,
        reactiveRecovery: true,
        collapse: true,
      },
    },
  },
  memory: {
    enabled: true,
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
  },
  skills: {
    baseDir: './skills',
    autoInject: true,
    injectOnMention: true,
    maxInjectedSkills: 3,
    maxDescriptionLength: 500,
  },
  tui: {
    history: {
      enabled: true,
      maxLines: 100,
      filePath: '~/.my-agent/history.txt',
    },
    sessions: {
      dir: '~/.my-agent/sessions',
    },
  },
  subAgent: {
    enabled: true,
    autoTriggerThreshold: 5,
    isolation: true,
    worktreeRootDir: '~/.my-agent/worktrees',
  },
  security: {
    allowedRoots: ['.'],
  },
  debug: {
    enabled: false,
  },
};
