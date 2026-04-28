import type { Settings } from './types';

export const defaultSettings: Settings = {
  llm: {
    provider: 'claude',
    model: 'claude-3-5-sonnet-20241022',
    maxTokens: 4096,
    temperature: 0.7,
    apiKey: null,
    baseURL: null,
  },
  context: {
    tokenLimit: 180000,
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
      collapseRatio: 0.95,
      toolOutputSnipThreshold: 8000,
      preserveRecentTurns: 4,
      summaryModel: 'claude-3-5-haiku-20241022',
      maxSummaryTokens: 1024,
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
  },
  skills: {
    baseDir: './skills',
    autoInject: true,
    injectOnMention: true,
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
