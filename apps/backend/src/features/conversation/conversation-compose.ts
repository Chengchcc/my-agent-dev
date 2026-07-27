import type { Database } from "bun:sqlite";
import type { McpClientManager } from "@my-agent-team/adapter-mcp";
import type { SessionManager } from "@my-agent-team/agent";
import type { ModelRegistry, ProviderAuth } from "@my-agent-team/ai";
import { ConversationCtx } from "@my-agent-team/plugin-conversation-context";
import type { BackendConfig } from "../../config.js";
import { ulid } from "../../infra/ids.js";
import type { AgentService } from "../agent/index.js";
import type { RelationshipService } from "../agent/relationship-service.js";
import type { RuntimeOpsStore } from "../runtime-ops/index.js";
import type { SettingsService } from "../settings/index.js";
import type { SpanSupervisor } from "../span/supervisor.js";
import { createConversationAgentFactory } from "./agent-factory.js";
import { createAgentProjection } from "./agent-projection.js";
import { createGoalStateStore, type GoalStateStore } from "./goal-state.js";
import { sqliteConversationAdapter } from "./index.js";
import { ConversationLock } from "./lock.js";
import { createConversationService } from "./service.js";

export interface ConversationFeature {
  convPort: ReturnType<typeof sqliteConversationAdapter>;
  convSvc: ReturnType<typeof createConversationService>;
  lock: ConversationLock;
  goalStore: GoalStateStore;
}

export function createConversationFeature(
  db: Database,
  config: BackendConfig,
  _supervisor: SpanSupervisor,
  agentSvc: AgentService,
  opsStore: RuntimeOpsStore,
  sessionManager: SessionManager,
  settingsSvc: SettingsService,
  mcpClientManager: McpClientManager,
  modelRegistry: ModelRegistry,
  relSvc: RelationshipService,
  lock: ConversationLock = new ConversationLock(),
): ConversationFeature {
  const convPort = sqliteConversationAdapter(db);
  const auth: ProviderAuth = { apiKey: config.anthropicApiKey, baseUrl: config.anthropicBaseUrl };
  const goalStore = createGoalStateStore(settingsSvc);

  // Agent factory: builds plugins, resolves model, creates session
  const agentFactory = createConversationAgentFactory({
    agentSvc,
    settingsSvc,
    mcpClientManager,
    modelRegistry,
    sessionManager,
    config,
    convPort,
    goalStore,
    auth,
  });

  // Agent projection: subscribes to events, projects to ledger
  const projection = createAgentProjection({ convPort, modelRegistry, auth });

  const activeSessions = new Map<
    string,
    Map<
      string,
      {
        steer: (text: string) => void;
        followUp: (text: string) => void;
      }
    >
  >();

  const convSvc = createConversationService({
    port: convPort,
    lock,
    activeSessions,
    maxConsecutiveAgentHops: () => settingsSvc.get<number>("conversation.maxHops") ?? 8,
    idGen: ulid,

    startAgentRun: async (spanId, ctx) => {
      const { conversationId, agentMemberId, agentId, input } = ctx;
      const members = convPort.getMembers(conversationId);
      const isLark = members.some((m) => m.kind === "human" && m.userRef?.startsWith("lark:"));
      const surface = isLark ? "lark" : "web";

      const { session, cwd: _cwd } = await agentFactory(
        conversationId,
        agentMemberId,
        agentId,
        input ?? "",
      );

      // Bind sessionId to member if new
      const existingSid = convPort.getMemberSessionId(conversationId, agentMemberId);
      if (!existingSid) {
        convPort.updateMemberSessionId(conversationId, agentMemberId, session.sessionId ?? "");
      }

      // Project events to conversation ledger
      projection.subscribeToAgent(
        session,
        conversationId,
        agentMemberId,
        spanId,
        convPort,
        (params) => convSvc.appendAssistantMessage(params),
      );

      // Set conversation context
      session.setContext(ConversationCtx, {
        id: conversationId,
        surface,
        senderName: agentMemberId,
        input: input ?? "",
      });

      // Register steer/followUp for postMessage injection
      if (!activeSessions.has(conversationId)) {
        activeSessions.set(conversationId, new Map());
      }
      activeSessions.get(conversationId)!.set(agentMemberId, {
        steer: (text: string) => {
          try {
            session.steer(text);
          } catch (err) {
            console.error(
              `[conversation] steer failed for ${agentMemberId}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        },
        followUp: (text: string) => {
          try {
            session.followUp(text);
          } catch (err) {
            console.error(
              `[conversation] followUp failed for ${agentMemberId}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        },
      });

      void session.prompt(input ?? "", {
        spanId,
        origin: { conversationId, agentMemberId: agentId, surface, originKind: "manual" },
      });

      return { spanId, attemptSeq: 0 };
    },

    verifyRunOwnsConversation: async (spanId, conversationId) => {
      const origin = opsStore.getSpanOrigin(spanId);
      if (!origin) throw new Error(`run not found: ${spanId}`);
      if (origin.conversationId !== conversationId) {
        throw new Error(`run ${spanId} does not belong to conversation ${conversationId}`);
      }
    },

    onClear: (conversationId: string) => {
      activeSessions.delete(conversationId);
      goalStore.clear(conversationId);
      for (const m of convPort.getMembers(conversationId)) {
        if (m.kind === "agent" && m.sessionId) {
          sessionManager.dispose(m.sessionId);
          convPort.updateMemberSessionId(conversationId, m.memberId, "");
        }
      }
    },

    onCompact: async (conversationId: string) => {
      for (const m of convPort.getMembers(conversationId)) {
        if (m.kind === "agent" && m.sessionId) {
          const session = sessionManager.get(m.sessionId);
          if (session) {
            try {
              await session.compact();
            } catch {
              // compaction is best-effort
            }
          }
        }
      }
    },
    getRelationshipEdges: (agentIds) => relSvc.getEdges(agentIds),
  });

  return { convPort, convSvc, lock, goalStore };
}
