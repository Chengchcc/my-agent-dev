import type { BackendModelRef } from "@my-agent-team/agent-backend";
import { ulid } from "../../infra/ids.js";
import type { AgentService } from "../agent/index.js";
import type { RelationshipService } from "../agent/relationship-service.js";
import type { AgentContextService } from "../agent-context/service.js";
import type { AgentRunService } from "../agent-run/service.js";
import type { SettingsService } from "../settings/index.js";
import { createGoalStateStore, type GoalStateStore } from "./goal-state.js";
import type { ConversationPort } from "./ports.js";
import { createConversationService } from "./service.js";

export interface ConversationFeature {
  convPort: ConversationPort;
  convSvc: ReturnType<typeof createConversationService>;
  goalStore: GoalStateStore;
}

/** Compose the Conversation feature on Phase 4 Agent Run services. Scope is
 *  the existing domain trio (Conversation + Agent Member + Context Branch) -
 *  no scope service, no pool, no in-memory sessions. */
export function createConversationFeature(input: {
  convPort: ConversationPort;
  agentSvc: AgentService;
  settingsSvc: SettingsService;
  relSvc: RelationshipService;
  agentRunService: AgentRunService;
  /** Break the execution<->cascade cycle: features.ts wires this to
   *  AgentRunExecutionService.dispatch once that service exists. */
  dispatchRun: (runId: string) => Promise<void>;
  contextService: AgentContextService;
}): ConversationFeature {
  const { convPort, agentSvc, settingsSvc, relSvc, agentRunService, dispatchRun, contextService } =
    input;

  const goalStore = createGoalStateStore(settingsSvc);

  const convSvc = createConversationService({
    port: convPort,
    agentRunService,
    dispatchRun,
    contextService,
    maxConsecutiveAgentHops: () => settingsSvc.get<number>("conversation.maxHops") ?? 8,
    idGen: ulid,
    resolveDefaultModel: async (agentId): Promise<BackendModelRef> => {
      const agent = await agentSvc.getById(agentId);
      // Coding Agent catalog keys models as `<provider>/<model>`.
      return { backendKind: "coding_agent", modelId: `${agent.modelProvider}/${agent.modelName}` };
    },
    getRelationshipEdges: (agentIds) => relSvc.getEdges(agentIds),
  });

  return { convPort, convSvc, goalStore };
}
