import { join } from "node:path";
import type { McpClientManager } from "@my-agent-team/adapter-mcp";
import type { Agent, ContextStore, SessionManager } from "@my-agent-team/agent";
import { createAgentSession } from "@my-agent-team/agent";
import type { ModelRegistry, ProviderAuth } from "@my-agent-team/ai";
import {
  ConversationContextKey,
  conversationContextPlugin,
} from "@my-agent-team/plugin-conversation-context";
import { goalPlugin } from "@my-agent-team/plugin-goal";
import { MemoryKey, memoryPlugin } from "@my-agent-team/plugin-memory";
import { PetBarkKey, petPlugin } from "@my-agent-team/plugin-pet";
import { SkillIndexKey } from "@my-agent-team/plugin-progressive-skill";
import { recapPlugin } from "@my-agent-team/plugin-recap";
import { TodoKey } from "@my-agent-team/plugin-todo";
import type { BackendConfig } from "../../config.js";
import type { AgentService } from "../agent/index.js";
import type { SettingsService } from "../settings/index.js";
import {
  convTools,
  createModel,
  defaultPlugins,
  defaultTools,
  resolveModel,
} from "../span/agent-helpers.js";
import type { GoalStateStore } from "./goal-state.js";
import type { ConversationPort } from "./ports.js";

export interface AgentFactoryDeps {
  agentSvc: AgentService;
  settingsSvc: SettingsService;
  mcpClientManager: McpClientManager;
  modelRegistry: ModelRegistry;
  sessionManager: SessionManager;
  config: BackendConfig;
  convPort: ConversationPort;
  goalStore: GoalStateStore;
  auth: ProviderAuth;
}

export interface AgentFactoryResult {
  session: Agent;
  cwd: string;
}

export function createConversationAgentFactory(deps: AgentFactoryDeps) {
  const {
    agentSvc,
    settingsSvc,
    mcpClientManager,
    modelRegistry,
    sessionManager,
    config,
    convPort,
    goalStore,
    auth,
  } = deps;

  return async function startAgentRun(
    conversationId: string,
    agentMemberId: string,
    agentId: string,
    _input: string,
  ): Promise<AgentFactoryResult> {
    const { modelProvider, modelName, name: agentName } = await agentSvc.getById(agentId);
    const cwd = join(config.dataDir, "agents", agentId);
    const cTools = convTools(convPort, conversationId);
    const mcpTools = mcpClientManager.getTools(agentId);

    const plugins = [
      ...defaultPlugins(cwd, config, undefined, agentName).filter((p) => p.name !== "memory"),
      conversationContextPlugin({ tools: cTools }),
      goalPlugin({
        goalCondition: () => goalStore.get(conversationId).condition,
        evaluatorModel: createModel(
          resolveModel("anthropic/claude-sonnet-4", modelRegistry),
          modelRegistry,
          auth,
        ),
        onEvaluation: ({ summary, evaluation }) => {
          const gs = goalStore.get(conversationId);
          if (gs.paused) return;
          gs.turns++;
          gs.history.push({
            turn: gs.turns,
            summary,
            met: evaluation.met,
            reason: evaluation.reason,
            ts: Date.now(),
          });
        },
      }),
      petPlugin({
        petModel: createModel(
          modelRegistry.getModel(
            settingsSvc.get<string>("pet.provider") ?? "anthropic",
            settingsSvc.get<string>("pet.model") ?? "claude-haiku-3-5",
          ) ?? modelRegistry.getModel("anthropic", "claude-haiku-3-5")!,
          modelRegistry,
          auth,
        ),
        cwd,
        enabled: settingsSvc.get<boolean>("pet.enabled") ?? false,
        settings: {
          get(key: string) {
            return settingsSvc.get<string>(`pet.${agentId}.${key}`);
          },
          getNumber(key: string) {
            return settingsSvc.get<number>(`pet.${agentId}.${key}`);
          },
          set(key: string, value: string) {
            settingsSvc.set(`pet.${agentId}.${key}`, value);
          },
        },
      }),
      recapPlugin({
        recapModel: createModel(
          modelRegistry.getModel(
            settingsSvc.get<string>("recap.provider") ?? "anthropic",
            settingsSvc.get<string>("recap.model") ?? "claude-haiku-3-5",
          ) ?? modelRegistry.getModel("anthropic", "claude-haiku-3-5")!,
          modelRegistry,
          auth,
        ),
        enabled: settingsSvc.get<boolean>("recap.enabled") ?? true,
      }),
      memoryPlugin({
        cwd,
        root: "./memory/",
        autoExtract: settingsSvc.get<boolean>("memory.autoExtract") ?? false,
        extractModel: createModel(
          modelRegistry.getModel(
            settingsSvc.get<string>("memory.extractProvider") ?? "anthropic",
            settingsSvc.get<string>("memory.extractModel") ?? "claude-haiku-3-5",
          ) ?? modelRegistry.getModel("anthropic", "claude-haiku-3-5")!,
          modelRegistry,
          auth,
        ),
        consolidateModel: createModel(
          modelRegistry.getModel(
            settingsSvc.get<string>("memory.consolidateProvider") ?? "anthropic",
            settingsSvc.get<string>("memory.consolidateModel") ?? "claude-sonnet-4-6",
          ) ?? modelRegistry.getModel("anthropic", "claude-sonnet-4-6")!,
          modelRegistry,
          auth,
        ),
        minMessagesForExtraction: settingsSvc.get<number>("memory.minMessagesForExtraction"),
        consolidateThreshold: settingsSvc.get<number>("memory.consolidateThreshold"),
      }),
    ];

    const existingSid = convPort.getMemberSessionId(conversationId, agentMemberId);

    const session = await createAgentSession({
      model: createModel(
        resolveModel(`${modelProvider}/${modelName}`, modelRegistry),
        modelRegistry,
        auth,
      ),
      plugins,
      tools: [...defaultTools(cwd), ...cTools, ...mcpTools],
      sessionManager,
      sessionId: existingSid ?? undefined,
      metaContext: ({ context }: { context: ContextStore }) => {
        const parts: string[] = [
          "<system-reminder>",
          `<current-date>${new Date().toISOString().slice(0, 10)}</current-date>`,
          "<workspace>",
          `  <root path="${cwd}" />`,
          "</workspace>",
        ];
        const skillIndex = context.get(SkillIndexKey);
        const convCtx = context.get(ConversationContextKey);
        if (convCtx) parts.push(convCtx);
        const memContent = context.get(MemoryKey);
        if (memContent) {
          parts.push("<memory>");
          parts.push(memContent);
          parts.push("</memory>");
        }
        if (skillIndex) {
          parts.push("<available-skills>");
          parts.push(skillIndex);
          parts.push("</available-skills>");
        }
        const todoProgress = context.get(TodoKey);
        if (todoProgress) parts.push(todoProgress);
        const petBark = context.get(PetBarkKey);
        if (petBark) {
          parts.push(`<pet mood="${petBark.mood}" level="${petBark.level}">`);
          parts.push(petBark.text);
          parts.push("</pet>");
        }
        parts.push("</system-reminder>");
        return parts.join("\n");
      },
    });

    return { session, cwd };
  };
}
