export interface LLMSettings {
  provider: 'claude' | 'openai';
  model: string;
  maxTokens: number;
  temperature: number;
  apiKey: string | null;
  baseURL: string | null;
}

export interface ContextSettings {
  tokenLimit: number;
}

export interface MemorySettings {
  enabled: boolean;
  globalBaseDir: string;
  maxSemanticEntries: number;
  maxEpisodicEntries: number;
  consolidationThreshold: number;
  autoExtractMinToolCalls: number;
  maxInjectedEntries: number;
  extractionModel: string;
}

export interface SkillsSettings {
  baseDir: string;
  autoInject: boolean;
  injectOnMention: boolean;
}

export interface HistorySettings {
  enabled: boolean;
  maxLines: number;
  filePath: string;
}

export interface SessionSettings {
  dir: string;
}

export interface TUISettings {
  history: HistorySettings;
  sessions: SessionSettings;
}

export interface SubAgentSettings {
  enabled: boolean;
  autoTriggerThreshold: number;
  isolation: boolean;
  worktreeRootDir: string;
}

export interface SecuritySettings {
  allowedRoots: string[];
}

export interface DebugSettings {
  enabled: boolean;
}

export interface Settings {
  llm: LLMSettings;
  context: ContextSettings;
  memory: MemorySettings;
  skills: SkillsSettings;
  tui: TUISettings;
  subAgent: SubAgentSettings;
  security: SecuritySettings;
  debug: DebugSettings;
}
