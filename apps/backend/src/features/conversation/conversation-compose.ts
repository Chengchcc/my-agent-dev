import type { BackendModelRef } from "@my-agent-team/agent-backend";
import type { Message } from "@my-agent-team/message";
import { ulid } from "../../infra/ids.js";
import { type AgentService, agentModelRef } from "../agent/index.js";
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
  /** Steer injection into the live run (features.ts wires it the same way). */
  injectSteer: (branchId: string, input: { inputId: string; message: Message }) => Promise<void>;
  contextService: AgentContextService;
}): ConversationFeature {
  const {
    convPort,
    agentSvc,
    settingsSvc,
    relSvc,
    agentRunService,
    dispatchRun,
    injectSteer,
    contextService,
  } = input;

  const goalStore = createGoalStateStore(settingsSvc);

  const convSvc = createConversationService({
    port: convPort,
    agentRunService,
    dispatchRun,
    injectSteer,
    contextService,
    maxConsecutiveAgentHops: () => settingsSvc.get<number>("conversation.maxHops") ?? 8,
    idGen: ulid,
    resolveDefaultModel: async (agentId): Promise<BackendModelRef> => {
      return agentModelRef(await agentSvc.getById(agentId));
    },
    getRelationshipEdges: (agentIds) => relSvc.getEdges(agentIds),
  });

  return { convPort, convSvc, goalStore };
}
