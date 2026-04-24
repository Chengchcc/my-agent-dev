import type { AgentConfig, Provider } from './types';
import type { Agent } from './agent';
import type { ToolRegistry } from './agent/tool-registry';
import type { ContextManager } from './agent/context';
import type { SessionStore } from './session/store';
import type { MemoryMiddleware } from './memory/middleware';

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
  askUserQuestionHandler?: (params: any) => Promise<any>;
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
  throw new Error('Not implemented');
}
