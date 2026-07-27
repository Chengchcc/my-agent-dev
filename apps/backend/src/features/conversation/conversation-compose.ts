import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { McpClientManager } from "@my-agent-team/adapter-mcp";
import type { ContextStore, SessionManager } from "@my-agent-team/agent";
import { createAgentSession } from "@my-agent-team/agent";
import type { ModelRegistry, ProviderAuth } from "@my-agent-team/ai";
import type { Message, MessageRevision } from "@my-agent-team/message";
import {
  deserializeLedgerContent,
  extractText,
  isTerminalMessageState,
  serializeMessageRevision,
  systemMessageId,
} from "@my-agent-team/message";
import {
  ConversationContextKey,
  ConversationCtx,
  conversationContextPlugin,
} from "@my-agent-team/plugin-conversation-context";
import { goalPlugin } from "@my-agent-team/plugin-goal";
import { MemoryKey, memoryPlugin } from "@my-agent-team/plugin-memory";
import { PetBarkKey, petPlugin } from "@my-agent-team/plugin-pet";
import { SkillIndexKey } from "@my-agent-team/plugin-progressive-skill";
import { recapPlugin } from "@my-agent-team/plugin-recap";
import { TodoKey } from "@my-agent-team/plugin-todo";
import type { BackendConfig } from "../../config.js";
import { ulid } from "../../infra/ids.js";
import type { AgentService } from "../agent/index.js";
import type { RelationshipService } from "../agent/relationship-service.js";
import type { RuntimeOpsStore } from "../runtime-ops/index.js";
import type { SettingsService } from "../settings/index.js";
import {
  convTools,
  createModel,
  defaultPlugins,
  defaultTools,
  resolveModel,
} from "../span/agent-helpers.js";
import type { SpanSupervisor } from "../span/supervisor.js";
import { createGoalStateStore, type GoalStateStore } from "./goal-state.js";
import { sqliteConversationAdapter } from "./index.js";
import { ConversationLock } from "./lock.js";
import type { ConversationPort } from "./ports.js";
import { escapeRegExp, getOrCreateAccumulator } from "./run-accumulator.js";
import { createConversationService } from "./service.js";
import { buildTitleContext, generateTitle } from "./title.js";

export interface ConversationFeature {
  convPort: ConversationPort;
  convSvc: ReturnType<typeof createConversationService>;
  lock: ConversationLock;
  goalStore: GoalStateStore;
}

const titlingInFlight = new Set<string>();
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

  // @mention regex cache
  const mentionCache = new Map<string, RegExp>();
  const getMentionRe = (label: string) => {
    let re = mentionCache.get(label);
    if (!re) {
      re = new RegExp(`@${escapeRegExp(label)}(?=\\s|[,.!?;:]|$)`, "g");
      mentionCache.set(label, re);
    }
    return re;
  };

  // Auto-title: fire-and-forget on first terminal response
  const autoTitle = async (cid: string) => {
    const model = createModel(resolveModel("anthropic/claude", modelRegistry), modelRegistry, auth);
    const entries = convPort.getLedgerEntries(cid).filter((e) => e.kind === "message");
    const msgs: Message[] = entries.slice(0, 6).map((e) => {
      const result = deserializeLedgerContent(e.content);
      if (!("messageId" in result)) {
        return { role: "user" as const, text: "" };
      }
      return {
        role: (result.role as Message["role"]) ?? "user",
        text: extractText({
          text: result.text ?? "",
          blocks: result.blocks ?? [],
        }),
      };
    });
    const ctx = buildTitleContext(msgs);
    const title = await generateTitle(() => model, ctx);
    if (title) convPort.setConversationTitle(cid, title);
  };

  // Message handling — writes to ledger, scans @mentions, broadcasts SSE
  const handleAssistantMessage = async (
    conversationId: string,
    agentMemberId: string,
    spanId: string,
    rev: MessageRevision,
  ) => {
    await convSvc.appendAssistantMessage({
      conversationId,
      senderMemberId: agentMemberId,
      spanId,
      revision: rev,
    });

    const acc = getOrCreateAccumulator(spanId, agentMemberId);
    if (rev.role === "assistant") {
      acc.latestAssistantRevision = { ...rev, conversationId };
      if (isTerminalMessageState(rev.state)) {
        // Auto-title: generate on first terminal response if no title yet
        const conv = convPort.getConversation(conversationId);
        if (conv && !conv.title && !titlingInFlight.has(conversationId)) {
          titlingInFlight.add(conversationId);
          void autoTitle(conversationId)
            .catch(() => {
              /* best-effort */
            })
            .finally(() => titlingInFlight.delete(conversationId));
        }
        const text = extractText(rev);
        if (text) {
          const roster = convPort.getMembers(conversationId);
          for (const m of roster) {
            if (m.kind !== "agent" || m.memberId === agentMemberId) continue;
            const label = m.displayName ?? m.memberId;
            if (getMentionRe(label).test(text) || text.includes(`@${m.memberId}`)) {
              acc.mentionedMemberIds.add(m.memberId);
            }
          }
        }
      }
    }
  };

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

      const { modelProvider, modelName, name: agentName } = await agentSvc.getById(agentId);
      const cwd = join(config.dataDir, "agents", agentId);
      const cTools = convTools(convPort, conversationId);
      const mcpTools = mcpClientManager.getTools(agentId);
      // Build plugins (unchanged from before)
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
        metaContext: ({
          context,
        }: {
          context: ContextStore;
          sessionId: string;
          threadMessages: readonly Message[];
        }) => {
          const parts: string[] = [
            `<system-reminder>`,
            `<current-date>${new Date().toISOString().slice(0, 10)}</current-date>`,
            `<workspace>`,
            `  <root path="${cwd}" />`,
            `</workspace>`,
          ];
          const skillIndex = context.get(SkillIndexKey);
          const convCtx = context.get(ConversationContextKey);
          if (convCtx) parts.push(convCtx);
          const memContent = context.get(MemoryKey);
          if (memContent) {
            parts.push(`<memory>`);
            parts.push(memContent);
            parts.push(`</memory>`);
          }
          if (skillIndex) {
            parts.push(`<available-skills>`);
            parts.push(skillIndex);
            parts.push(`</available-skills>`);
          }
          const todoProgress = context.get(TodoKey);
          if (todoProgress) parts.push(todoProgress);
          const petBark = context.get(PetBarkKey);
          if (petBark) {
            parts.push(`<pet mood="${petBark.mood}" level="${petBark.level}">`);
            parts.push(petBark.text);
            parts.push(`</pet>`);
          }
          parts.push(`</system-reminder>`);
        },
      });
      if (!existingSid) {
        convPort.updateMemberSessionId(conversationId, agentMemberId, session.sessionId ?? "");
      }
      // Business event subscription
      session.subscribe((event) => {
        if (event.type === "message_update" || event.type === "message") {
          const rev = event.payload as MessageRevision;
          void handleAssistantMessage(conversationId, agentMemberId, rev.spanId ?? spanId, rev);
        }
        if (event.type === "queue_update") {
          // Forward transient queue state to conversation SSE via a system message.
          // queue_update is not persisted as a ledger kind — reused kind:"message"
          // with __system__ sender + text-encoded { type, steering, followUp }.
          const ts = Date.now();
          const serialized = serializeMessageRevision({
            messageId: systemMessageId(conversationId, "queue"),
            role: "system",
            state: "done",
            text: JSON.stringify({
              type: "queue_update",
              steering: event.steering,
              followUp: event.followUp,
            }),
            conversationId,
            visibility: "conversation",
            updatedAt: ts,
          });
          void convPort.appendLedgerEntry({
            conversationId,
            senderMemberId: "__system__",
            addressedTo: [],
            kind: "message",
            content: serialized,
            ts,
          });
        }
        if (event.type === "todo_update") {
          const acc = getOrCreateAccumulator(event.spanId ?? spanId, agentMemberId);
          acc.lastTodoUpdate = {
            todos: (event as { payload: { todos: Array<{ step: string; status: string }> } })
              .payload.todos,
          };
        }
        if (event.type === "pet_bark") {
          const ts = Date.now();
          void convPort.appendLedgerEntry({
            conversationId,
            senderMemberId: agentMemberId,
            addressedTo: [],
            kind: "pet_bark",
            content: JSON.stringify(event.payload),
            ts,
            spanId: spanId,
          });
        }
        if (event.type === "recap_update") {
          const ts = Date.now();
          void convPort.appendLedgerEntry({
            conversationId,
            senderMemberId: agentMemberId,
            addressedTo: [],
            kind: "recap",
            content: JSON.stringify(event.payload),
            ts,
            spanId: spanId,
          });
        }
      });
      // Execute — origin via prompt opts, context via setContext
      session.setContext(ConversationCtx, {
        id: conversationId,
        surface,
        senderName: agentMemberId,
        input: input ?? "",
      });
      // Register steer/followUp so postMessage can inject into a running/alive session
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
