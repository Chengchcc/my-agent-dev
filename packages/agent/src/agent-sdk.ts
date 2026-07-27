import { Agent } from "./agent.js";
import type { AgentHooks } from "./agent-hooks.js";
import type { AgentConfig } from "./agent-options.js";
import type { AgentExtension, AgentExtensionFactory, AgentScope } from "./extension-host.js";
import { composeExtensions, ExtensionHost } from "./extension-host.js";
import type { ChatModel, Tool } from "./framework-adapter.js";
import { resolveModel } from "./model-runtime.js";
import type { ModelRef, ModelRuntime } from "./model-runtime.js";
import type { SessionManager } from "./session-manager.js";

export interface CreateAgentSessionInput {
  scope: AgentScope;
  model: ChatModel | ModelRef;
  modelRuntime?: ModelRuntime;
  extensions?: readonly AgentExtensionFactory[];
  tools?: readonly Tool[];
  systemPrompt?: string;
  sessionManager?: SessionManager;
  hooks?: AgentHooks;
  contextManager?: AgentConfig["contextManager"];
  logger?: AgentConfig["logger"];
  retry?: AgentConfig["retry"];
  compaction?: AgentConfig["compaction"];
}

/**
 * Create an Agent session.
 *
 * - ChatModel: direct (test, custom providers)
 * - ModelRef string: requires modelRuntime (production)
 *
 * Extensions are resolved per scope and composed in registration order.
 * input.hooks are folded into the composition chain, not an override.
 */
export async function createAgentSession(input: CreateAgentSessionInput): Promise<Agent> {
  const resolvedModel = await resolveModel(input.model, input.modelRuntime);

  // Resolve extension factories
  const host = new ExtensionHost(input.extensions ?? []);
  const resolved = await host.resolve(input.scope);

  // Convert resolved extensions to AgentExtension list
  const extensions: AgentExtension[] = resolved.map((r) => r.extension);

  // Fold input.hooks into the chain as a bootstrap extension
  if (input.hooks) {
    extensions.push({ id: "bootstrap", hooks: input.hooks });
  }

  // Compose everything once
  const composed = composeExtensions({
    resolved: extensions.map((ext, _i) => ({ id: ext.id, extension: ext })),
    baseTools: input.tools ?? [],
    baseSystemPrompt: input.systemPrompt,
  });

  const agentConfig: AgentConfig = {
    model: resolvedModel.chatModel,
    tools: composed.tools ? [...composed.tools] : input.tools ? [...input.tools] : undefined,
    hooks: composed.hooks,
    systemPrompt: composed.systemPrompt || undefined,
    contextManager: input.contextManager,
    logger: input.logger,
    retry: input.retry,
    compaction: input.compaction,
  };

  if (input.sessionManager) {
    const sid = input.scope.sessionId;
    return sid
      ? input.sessionManager.open(sid, agentConfig)
      : input.sessionManager.create(agentConfig);
  }

  return new Agent({
    ...agentConfig,
    sessionId: input.scope.sessionId,
  });
}
