import { z } from 'zod';

export const llmSettingsSchema = z.object({
  provider: z.enum(['claude', 'openai']).default('claude'),
  model: z.string().default('claude-3-5-sonnet-20241022'),
  maxTokens: z.number().int().positive().default(4096),
  temperature: z.number().min(0).max(2).default(0.7),
  apiKey: z.string().nullable().default(null),
  baseURL: z.string().nullable().default(null),
});

export const contextSettingsSchema = z.object({
  tokenLimit: z.number().int().positive().default(100000),
});

export const memorySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  globalBaseDir: z.string().default('~/.my-agent/memory'),
  maxSemanticEntries: z.number().int().positive().default(200),
  maxEpisodicEntries: z.number().int().positive().default(500),
  consolidationThreshold: z.number().int().positive().default(50),
  autoExtractMinToolCalls: z.number().int().positive().default(3),
  maxInjectedEntries: z.number().int().positive().default(10),
  extractionModel: z.string().default('claude-3-haiku-20240307'),
});

export const skillsSettingsSchema = z.object({
  baseDir: z.string().default('./skills'),
  autoInject: z.boolean().default(true),
  injectOnMention: z.boolean().default(true),
});

export const historySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  maxLines: z.number().int().positive().default(100),
  filePath: z.string().default('~/.my-agent/history.txt'),
});

export const sessionSettingsSchema = z.object({
  dir: z.string().default('~/.my-agent/sessions'),
});

export const tuiSettingsSchema = z.object({
  history: historySettingsSchema,
  sessions: sessionSettingsSchema,
});

export const subAgentSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  autoTriggerThreshold: z.number().int().positive().default(5),
  isolation: z.boolean().default(true),
  worktreeRootDir: z.string().default('~/.my-agent/worktrees'),
});

export const securitySettingsSchema = z.object({
  allowedRoots: z.array(z.string()).default(['.']),
});

export const debugSettingsSchema = z.object({
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

export type SettingsSchema = z.infer<typeof settingsSchema>;
