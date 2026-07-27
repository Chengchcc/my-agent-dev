import { Agent } from "./agent.js";
import type { AgentConfig } from "./agent-options.js";
import type { Tool } from "./framework-adapter.js";
import { resolveModel } from "./model-runtime.js";
import type { ModelRef, ModelRuntime } from "./model-runtime.js";
import type { SessionManager } from "./session-manager.js";

export interface CreateAgentSessionInput {
  /** ModelRef string (requires modelRuntime) or already-resolved ChatModel. */
  model: ChatModel | ModelRef;

  /** Required when model is a ModelRef string. */
  modelRuntime?: ModelRuntime;

  /** Pre-built plugins — the canonical extension mechanism. */
  plugins?: AgentConfig["plugins"];

  /** Base tools (conversation, MCP, built-in). */
  tools?: readonly Tool[];

  /** For SessionManager.open — reuses existing session. */
  // Transient sessions only (Skill Pack). Managed sessions use sessionManager.
  checkpointer?: AgentConfig["checkpointer"];
  sessionId?: string;

  /** Session persistence. When provided, open/create is delegated. */
  sessionManager?: SessionManager;

  /** Forwarded directly to AgentConfig. */
  contextManager?: AgentConfig["contextManager"];

  /** Forwarded directly to AgentConfig. */
  metaContext?: AgentConfig["metaContext"];

  /** Forwarded directly to AgentConfig. */
  systemPrompt?: string;

  /** Forwarded directly to AgentConfig. */
  logger?: AgentConfig["logger"];

  /** Forwarded directly to AgentConfig. */
  retry?: AgentConfig["retry"];

  /** Forwarded directly to AgentConfig. */
  compaction?: AgentConfig["compaction"];
}

// Re-import ChatModel for type use
import type { ChatModel } from "./framework-adapter.js";

/**
 * Create an Agent session — thin facade over AgentConfig + SessionManager.
 *
 * Two model modes:
 * - ChatModel: direct (tests, custom providers)
 * - ModelRef string: requires modelRuntime (production)
 *
 * Plugins are the canonical extension mechanism. Hooks/tools/systemPrompt
 * inside plugins are composed by the framework's existing plugin system.
 */
export async function createAgentSession(input: CreateAgentSessionInput): Promise<Agent> {
  const resolvedModel = await resolveModel(input.model, input.modelRuntime);

  const config: AgentConfig = {
    model: resolvedModel.chatModel,
    plugins: input.plugins,
    tools: input.tools ? [...input.tools] : undefined,
    contextManager: input.contextManager,
    metaContext: input.metaContext,
    systemPrompt: input.systemPrompt,
    logger: input.logger,
    retry: input.retry,
    compaction: input.compaction,
    checkpointer: input.checkpointer,
  };

  if (input.sessionManager) {
    return input.sessionId
      ? input.sessionManager.open(input.sessionId, config)
      : input.sessionManager.create(config);
  }

  return new Agent({
    ...config,
    sessionId: input.sessionId,
  });
}
