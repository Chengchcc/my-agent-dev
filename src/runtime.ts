import type { AgentConfig, Provider } from './types';
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
import { SessionStore } from './session/store';
import { createAutoSaveHook } from './session/hook';
import type { AskUserQuestionParameters, AskUserQuestionResult } from './tools/ask-user-question';
import { BashTool, TextEditorTool, AskUserQuestionTool, ReadTool, GrepTool, GlobTool, LsTool } from './tools';
import { ClaudeProvider } from './providers/claude';
import { OpenAIProvider } from './providers/openai';

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
  systemPrompt?: string;
  askUserQuestionHandler?: (params: AskUserQuestionParameters) => Promise<AskUserQuestionResult>;
}

export interface AgentRuntime {
  agent: Agent;
  provider: Provider;
  toolRegistry: ToolRegistry;
  contextManager: ContextManager;
  sessionStore: SessionStore;
  memoryMiddleware?: MemoryMiddleware;
  shutdown: () => Promise<void>;
}

export async function createAgentRuntime(
  config: RuntimeConfig = {},
): Promise<AgentRuntime> {
  const {
    provider: providerName,
    model,
    maxTokens = 4096,
    tokenLimit = 100_000,
    cwd = process.cwd(),
    enableMemory = true,
    enableSkills = true,
    enableTodo = true,
    enableSession = true,
    systemPrompt,
    askUserQuestionHandler,
  } = config;

  let provider: Provider;
  const hasClaudeKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  const hasOpenaiKey = process.env.OPENAI_API_KEY;

  if (providerName === 'openai' && hasOpenaiKey) {
    provider = new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      baseURL: process.env.OPENAI_BASE_URL,
      model: model || process.env.MODEL || 'gpt-4o',
      maxTokens,
      temperature: 0.7,
    });
  } else if (providerName === 'claude' && hasClaudeKey) {
    provider = new ClaudeProvider({
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN!,
      baseURL: process.env.ANTHROPIC_BASE_URL,
      model: model || process.env.MODEL || 'claude-3-5-sonnet-20241022',
      maxTokens,
      temperature: 0.7,
    });
  } else if (!providerName) {
    // Auto-detect
    if (hasClaudeKey) {
      provider = new ClaudeProvider({
        apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN!,
        baseURL: process.env.ANTHROPIC_BASE_URL,
        model: model || process.env.MODEL || 'claude-3-5-sonnet-20241022',
        maxTokens,
        temperature: 0.7,
      });
    } else if (hasOpenaiKey) {
      provider = new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY!,
        baseURL: process.env.OPENAI_BASE_URL,
        model: model || process.env.MODEL || 'gpt-4o',
        maxTokens,
        temperature: 0.7,
      });
    } else {
      throw new Error('No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
    }
  } else {
    throw new Error(`Provider '${providerName}' not available or no API key found.`);
  }

  const contextManager = new ContextManager({ tokenLimit });
  if (systemPrompt) {
    contextManager.setSystemPrompt(systemPrompt);
  }
  const agentConfig: AgentConfig = { tokenLimit };

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(new BashTool({ allowedWorkingDirs: [cwd] }));
  toolRegistry.register(new TextEditorTool({ allowedRoots: [cwd] }));
  toolRegistry.register(new ReadTool());
  toolRegistry.register(new GrepTool());
  toolRegistry.register(new GlobTool());
  toolRegistry.register(new LsTool());

  const defaultHeadlessHandler = async () => ({
    answers: [],
  });
  toolRegistry.register(new AskUserQuestionTool(
    askUserQuestionHandler ?? defaultHeadlessHandler,
  ));

  const hooks: any = {
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
  let skillMiddleware: any;
  if (enableSkills) {
    skillMiddleware = createSkillMiddleware({ autoInject: true, injectOnMention: true });
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

  // Agent
  const agent = new Agent({
    provider,
    contextManager,
    config: agentConfig,
    toolRegistry,
    hooks,
  });

  return {
    agent,
    provider,
    toolRegistry,
    contextManager,
    sessionStore,
    memoryMiddleware,
    shutdown: async () => {
      if (memoryMiddleware) {
        await memoryMiddleware.awaitPendingExtractions();
      }
    },
  };
}
