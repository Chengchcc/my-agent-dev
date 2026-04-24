import type { AgentConfig, Provider } from './types';
import { Agent } from './agent/Agent';
import type { ToolRegistry } from './agent/tool-registry';
import { ContextManager } from './agent/context';
import type { SessionStore } from './session/store';
import type { MemoryMiddleware } from './memory/middleware';
import type { AskUserQuestionParameters, AskUserQuestionResult } from './tools/ask-user-question';
import { ClaudeProvider } from './providers/claude';
import { OpenAIProvider } from './providers/openai';

export interface RuntimeConfig {
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
  if (process.env.ANTHROPIC_API_KEY) {
    provider = new ClaudeProvider({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL,
      model: model || process.env.MODEL || 'claude-3-5-sonnet-20241022',
      maxTokens,
      temperature: 0.7,
    });
  } else if (process.env.OPENAI_API_KEY) {
    provider = new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      model: model || process.env.MODEL || 'gpt-4o',
      maxTokens,
      temperature: 0.7,
    });
  } else {
    throw new Error('No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
  }

  const contextManager = new ContextManager({ tokenLimit });
  if (systemPrompt) {
    contextManager.setSystemPrompt(systemPrompt);
  }
  const agentConfig: AgentConfig = { tokenLimit };

  // Create dummy tool registry for now (will be implemented in later tasks)
  const toolRegistry = {
    getAllDefinitions: () => [],
    get: () => undefined,
  } as unknown as ToolRegistry;

  // Create dummy session store for now
  const sessionStore = {} as SessionStore;

  const agent = new Agent({
    provider,
    contextManager,
    config: agentConfig,
    toolRegistry,
  });

  return {
    agent,
    provider,
    toolRegistry,
    contextManager,
    sessionStore,
    shutdown: async () => {},
  };
}
