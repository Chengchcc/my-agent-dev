import { z } from 'zod';

const llmSettingsSchema = z.object({
  provider: z.enum(['claude', 'openai']).default('claude'),
  model: z.string().default('claude-3-5-sonnet-20241022'),
  maxTokens: z.number().int().positive().default(4096),
  temperature: z.number().min(0).max(2).default(0.7),
  apiKey: z.string().nullable().default(null),
  baseURL: z.string().nullable().default(null),
});

const compactionSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  snipRatio: z.number().min(0).max(1).default(0.60),
  autoCompactRatio: z.number().min(0).max(1).default(0.75),
  collapseRatio: z.number().min(0).max(1).default(0.95),
  toolOutputSnipThreshold: z.number().int().positive().default(8000),
  preserveRecentTurns: z.number().int().positive().default(4),
  summaryModel: z.string().default('claude-3-5-haiku-20241022'),
  maxSummaryTokens: z.number().int().positive().default(1024),
  enabledTiers: z.object({
    snip: z.boolean().default(true),
    autoCompact: z.boolean().default(true),
    reactiveRecovery: z.boolean().default(true),
    collapse: z.boolean().default(true),
  }).default({
    snip: true,
    autoCompact: true,
    reactiveRecovery: true,
    collapse: true,
  }),
});

const contextSettingsSchema = z.object({
  tokenLimit: z.number().int().positive().default(180000),
  compaction: compactionSettingsSchema.optional(),
});

const memorySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  globalBaseDir: z.string().default('~/.my-agent/memory'),
  maxSemanticEntries: z.number().int().positive().default(200),
  maxEpisodicEntries: z.number().int().positive().default(500),
  consolidationThreshold: z.number().int().positive().default(50),
  autoExtractMinToolCalls: z.number().int().positive().default(3),
  maxInjectedEntries: z.number().int().positive().default(10),
  extractionModel: z.string().default('claude-3-haiku-20240307'),
  retrievalThreshold: z.number().min(0).max(1).default(0.75),
  retrievalTopK: z.number().int().positive().default(5),
  extractTriggerMode: z.enum(['explicit', 'auto', 'off']).default('explicit'),
  maxUserPreferences: z.number().int().positive().default(20),
});

const skillsSettingsSchema = z.object({
  baseDir: z.string().default('./skills'),
  autoInject: z.boolean().default(true),
  injectOnMention: z.boolean().default(true),
  maxInjectedSkills: z.number().int().positive().default(3),
  maxDescriptionLength: z.number().int().positive().default(500),
});

const historySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  maxLines: z.number().int().positive().default(100),
  filePath: z.string().default('~/.my-agent/history.txt'),
});

const sessionSettingsSchema = z.object({
  dir: z.string().default('~/.my-agent/sessions'),
});

const tuiSettingsSchema = z.object({
  history: historySettingsSchema,
  sessions: sessionSettingsSchema,
});

const subAgentSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  autoTriggerThreshold: z.number().int().positive().default(5),
  isolation: z.boolean().default(true),
  worktreeRootDir: z.string().default('~/.my-agent/worktrees'),
});

const securitySettingsSchema = z.object({
  allowedRoots: z.array(z.string()).default(['.']),
});

const debugSettingsSchema = z.object({
  enabled: z.boolean().default(false),
});

export const settingsSchema = z.object({
  llm: llmSettingsSchema,
  context: contextSettingsSchema,
  memory: memorySettingsSchema,
  skills: skillsSettingsSchema,
  tui: tuiSettingsSchema,
  subAgent: subAgentSettingsSchema,
  security: securitySettingsSchema,
  debug: debugSettingsSchema,
});

