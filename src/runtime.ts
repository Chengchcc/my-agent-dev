import type { AgentConfig, Provider, AgentHooks } from './types';
import type { LLMSettings, ContextSettings } from './config/types';
import { Agent } from './agent/Agent';
import { ToolRegistry } from './agent/tool-registry';
import { ContextManager } from './agent/context';
import { SubAgentTool } from './agent/sub-agent-tool';
import { createTodoMiddleware } from './todos';
import {
  JsonlMemoryStore, KeywordRetriever, LlmExtractor,
  MemoryMiddleware, MemoryTool,
} from './memory';
import { createSkillMiddleware } from './skills/middleware';
import { SkillLoader } from './skills/loader';
import { SessionStore } from './session/store';
import { createAutoSaveHook } from './session/hook';
import type { AskUserQuestionParameters, AskUserQuestionResult } from './tools/ask-user-question';
import { BashTool, TextEditorTool, AskUserQuestionTool, ReadTool, GrepTool, GlobTool, LsTool } from './tools';
import { ClaudeProvider, OpenAIProvider, createProviderFromSettings } from './providers';
import { DEFAULT_SYSTEM_PROMPT } from './config/default-prompts';
import { TokenBudgetCalculator, TieredCompactionManager, DEFAULT_COMPACTION_CONFIG } from './agent/compaction';
import { debugLog } from './utils/debug';
import { PermissionMiddleware } from './agent/tool-dispatch/middlewares/permission';
import { ReadCacheMiddleware } from './agent/tool-dispatch/middlewares/read-cache';
import type { ToolMiddleware } from './agent/tool-dispatch/middleware';

export interface RuntimeConfig {
  provider?: 'claude' | 'openai';
  model?: string;
  maxTokens?: number;
  tokenLimit?: number;
  cwd?: string;
  enableMemory?: boolean;
  enableSkills?: boolean;
  enableTodo?: boolean;
  enableSession?: boolean;
  enableCompaction?: boolean;
  systemPrompt?: string;
  allowedRoots?: string[];
  askUserQuestionHandler?: (params: AskUserQuestionParameters) => Promise<AskUserQuestionResult>;
  /** For TUI mode: full settings object overrides individual options */
  settings?: {
    llm: LLMSettings;
    context: ContextSettings;
    security?: { allowedRoots?: string[] };
  };
}

export interface AgentRuntime {
  agent: Agent;
  provider: Provider;
  toolRegistry: ToolRegistry;
  contextManager: ContextManager;
  sessionStore: SessionStore;
  memoryMiddleware?: MemoryMiddleware;
  skillLoader?: SkillLoader;
  shutdown: () => Promise<void>;
}

export async function createAgentRuntime(
  config: RuntimeConfig = {},
): Promise<AgentRuntime> {
  const {
    cwd = process.cwd(),
    enableMemory = true,
    enableSkills = true,
    enableTodo = true,
    enableSession = true,
    enableCompaction = true,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    allowedRoots: allowedRootsOverride,
    askUserQuestionHandler,
    settings,
  } = config;

  // Resolve allowedRoots: settings.security.allowedRoots → explicit override → cwd
  const allowedRoots = allowedRootsOverride
    ?? settings?.security?.allowedRoots
    ?? [cwd];

  // Create provider - from settings or auto-detect from env
  let provider: Provider;
  if (settings) {
    provider = createProviderFromSettings(settings.llm);
  } else {
    provider = createProviderFromEnv(config);
  }

  // Token limit - from settings or default
  const tokenLimit = settings?.context.tokenLimit || 100_000;
  const maxTokens = settings?.llm.maxTokens || 4096;

  // Context manager with optional tiered compaction
  let compressionStrategy: TieredCompactionManager | undefined;
  if (enableCompaction && settings?.context.compaction) {
    const tokenBudgetCalc = new TokenBudgetCalculator(
      tokenLimit,
      maxTokens,
      2048, // compaction buffer
    );

    const compactionConfig = {
      ...DEFAULT_COMPACTION_CONFIG,
      thresholds: {
        ...DEFAULT_COMPACTION_CONFIG.thresholds,
        ...settings.context.compaction,
      },
      summaryProvider: provider,
      summaryModel: settings.context.compaction.summaryModel || 'claude-3-5-haiku-20241022',
    };

    compressionStrategy = new TieredCompactionManager(tokenBudgetCalc, compactionConfig);
    debugLog('Tiered compaction enabled');
  }

  const contextManagerConfig: any = {
    tokenLimit,
    defaultSystemPrompt: systemPrompt,
  };
  if (compressionStrategy) contextManagerConfig.compressionStrategy = compressionStrategy;
  const contextManager = new ContextManager(contextManagerConfig);

  const agentConfig: AgentConfig = { tokenLimit };

  // Tool registry with security boundaries
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(new BashTool({ allowedWorkingDirs: allowedRoots }));
  toolRegistry.register(new TextEditorTool(allowedRoots));
  toolRegistry.register(new ReadTool());
  toolRegistry.register(new GrepTool());
  toolRegistry.register(new GlobTool());
  toolRegistry.register(new LsTool());

  const defaultHeadlessHandler = async () => {
    throw new Error('ask_user_question tool is not available in headless mode');
  };
  toolRegistry.register(new AskUserQuestionTool(
    askUserQuestionHandler ?? defaultHeadlessHandler,
  ));

  const hooks: Required<Pick<AgentHooks, 'beforeAgentRun' | 'beforeModel' | 'afterAgentRun'>> = {
    beforeAgentRun: [],
    beforeModel: [],
    afterAgentRun: [],
  };

  // Todo
  if (enableTodo) {
    const { tool: todoTool, hooks: todoHooks } = createTodoMiddleware();
    toolRegistry.register(todoTool);
    if (todoHooks.beforeModel) hooks.beforeModel.push(todoHooks.beforeModel);
  }

  // Sub Agent
  toolRegistry.register(new SubAgentTool({
    mainProvider: provider,
    mainToolRegistry: toolRegistry,
    mainAgentConfig: agentConfig,
  }));

  // Memory
  let memoryMiddleware: MemoryMiddleware | undefined;
  if (enableMemory) {
    const semanticStore = new JsonlMemoryStore('semantic');
    const episodicStore = new JsonlMemoryStore('episodic');
    const projectStore = new JsonlMemoryStore('project', {}, cwd);
    const retriever = new KeywordRetriever(semanticStore, episodicStore, projectStore);
    const extractor = new LlmExtractor(provider);
    memoryMiddleware = new MemoryMiddleware(
      { semantic: semanticStore, episodic: episodicStore, project: projectStore },
      retriever, extractor,
    );
    toolRegistry.register(new MemoryTool(
      { semantic: semanticStore, episodic: episodicStore, project: projectStore },
      retriever, extractor,
    ));
    if (memoryMiddleware.beforeModel) hooks.beforeModel.push(memoryMiddleware.beforeModel);
    if (memoryMiddleware.afterAgentRun) hooks.afterAgentRun.push(memoryMiddleware.afterAgentRun);
  }

  // Skills
  let skillMiddleware: ReturnType<typeof createSkillMiddleware> | undefined;
  let skillLoader: SkillLoader | undefined;
  if (enableSkills) {
    skillLoader = new SkillLoader();
    skillMiddleware = createSkillMiddleware({ skillLoader, autoInject: true, injectOnMention: true });
    hooks.beforeAgentRun.push(skillMiddleware.beforeAgentRun);
    hooks.beforeModel.push(skillMiddleware.beforeModel);
    await skillMiddleware.preloadAll();
  }

  // Session
  const sessionStore = new SessionStore();
  if (enableSession) {
    await sessionStore.ensureSessionDir();
    sessionStore.createNewSession();
    hooks.afterAgentRun.push(createAutoSaveHook(sessionStore));
  }

  // Build default tool middleware chain
  // Order in array = outer to inner (first registered runs first):
  //   Permission (deny check) → ReadCache (cache check) → tool.execute
  const toolMiddlewares: ToolMiddleware[] = [
    new PermissionMiddleware({
      denyInSubAgent: ['sub_agent', 'ask_user_question'],
    }),
    new ReadCacheMiddleware(),
  ];

  // Agent
  const agent = new Agent({
    provider,
    contextManager,
    config: agentConfig,
    toolRegistry,
    hooks,
    toolMiddlewares,
  });

  const runtime: any = {
    agent,
    provider,
    toolRegistry,
    contextManager,
    sessionStore,
    shutdown: async () => {
      if (memoryMiddleware) {
        await memoryMiddleware.awaitPendingExtractions();
      }
    },
  };
  if (memoryMiddleware) runtime.memoryMiddleware = memoryMiddleware;
  if (skillLoader) runtime.skillLoader = skillLoader;
  return runtime;
}

/**
 * Create provider from environment variables (headless mode fallback).
 */
function createProviderFromEnv(config: RuntimeConfig): Provider {
  const {
    provider: providerName,
    model,
    maxTokens = 4096,
  } = config;

  const hasClaudeKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  const hasOpenaiKey = process.env.OPENAI_API_KEY;

  if (providerName === 'openai' && hasOpenaiKey) {
    const openaiConfig: any = {
      apiKey: process.env.OPENAI_API_KEY!,
      model: model || process.env.MODEL || 'gpt-4o',
      maxTokens,
      temperature: 0.7,
    };
    if (process.env.OPENAI_BASE_URL) openaiConfig.baseURL = process.env.OPENAI_BASE_URL;
    return new OpenAIProvider(openaiConfig);
  } else if (providerName === 'claude' && hasClaudeKey) {
    const claudeConfig: any = {
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN!,
      model: model || process.env.MODEL || 'claude-3-5-sonnet-20241022',
      maxTokens,
      temperature: 0.7,
    };
    if (process.env.ANTHROPIC_BASE_URL) claudeConfig.baseURL = process.env.ANTHROPIC_BASE_URL;
    return new ClaudeProvider(claudeConfig);
  } else if (!providerName) {
    if (hasClaudeKey) {
      const claudeConfig: any = {
        apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN!,
        model: model || process.env.MODEL || 'claude-3-5-sonnet-20241022',
        maxTokens,
        temperature: 0.7,
      };
      if (process.env.ANTHROPIC_BASE_URL) claudeConfig.baseURL = process.env.ANTHROPIC_BASE_URL;
      return new ClaudeProvider(claudeConfig);
    } else if (hasOpenaiKey) {
      const openaiConfig: any = {
        apiKey: process.env.OPENAI_API_KEY!,
        model: model || process.env.MODEL || 'gpt-4o',
        maxTokens,
        temperature: 0.7,
      };
      if (process.env.OPENAI_BASE_URL) openaiConfig.baseURL = process.env.OPENAI_BASE_URL;
      return new OpenAIProvider(openaiConfig);
    }
    throw new Error('No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
  }
  throw new Error(`Provider '${providerName}' not available or no API key found.`);
}
