import type {
  AgentContext,
  AgentConfig,
  Middleware,
  Provider,
  AgentHooks,
} from '../types';
import type { AgentEvent, AgentLoopConfig } from './loop-types';
import type { ContextManager } from './context';
import { ToolRegistry } from './tool-registry';
import { ToolDispatcher } from './tool-dispatch/dispatcher';
import type { ToolMiddleware } from './tool-dispatch/middleware';
import { AgentLoop } from './agent-loop';

export class Agent {
  private provider: Provider;
  private contextManager: ContextManager;
  private hooks: Required<AgentHooks>;
  readonly config: AgentConfig;
  private toolRegistry: ToolRegistry | null;
  private activeLoop: AgentLoop | null = null;
  private dispatcher: ToolDispatcher;

  constructor(options: {
    provider: Provider;
    contextManager: ContextManager;
    hooks?: AgentHooks;
    config: AgentConfig;
    toolRegistry?: ToolRegistry;
    /** @deprecated Use hooks.beforeModel instead */
    middleware?: Middleware[];
    toolMiddlewares?: ToolMiddleware[];
  }) {
    this.provider = options.provider;
    this.contextManager = options.contextManager;
    this.config = options.config;
    this.toolRegistry = options.toolRegistry ?? null;
    this.hooks = {
      beforeAgentRun: options.hooks?.beforeAgentRun ?? [],
      beforeCompress: options.hooks?.beforeCompress ?? [],
      beforeModel: [
        ...(options.middleware ?? []),
        ...(options.hooks?.beforeModel ?? []),
      ],
      afterModel: options.hooks?.afterModel ?? [],
      beforeAddResponse: options.hooks?.beforeAddResponse ?? [],
      afterAgentRun: options.hooks?.afterAgentRun ?? [],
    };

    this.dispatcher = new ToolDispatcher(
      this.toolRegistry ?? new ToolRegistry(),
      options.toolMiddlewares ?? [],
    );

    if (this.toolRegistry) {
      this.provider.registerTools(this.toolRegistry.getAllDefinitions());
    }
  }

  getContext(): AgentContext {
    return this.contextManager.getContext(this.config);
  }

  clear(): void {
    this.contextManager.clear();
  }

  abort(): void {
    this.activeLoop?.abort();
  }

  async *runAgentLoop(
    userMessage: { role: 'user'; content: string },
    loopConfig?: Partial<AgentLoopConfig>,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<AgentEvent> {
    const loop = new AgentLoop(
      this.provider,
      this.contextManager,
      this.hooks,
      this.config,
      this.dispatcher,
    );

    this.activeLoop = loop;
    yield* loop.run(userMessage, loopConfig, options);
    this.activeLoop = null;
  }

  getContextManager(): ContextManager {
    return this.contextManager;
  }

  getModelName(): string {
    return this.provider.getModelName();
  }
}
