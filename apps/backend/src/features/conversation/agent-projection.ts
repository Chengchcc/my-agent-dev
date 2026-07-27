import type { Agent } from "@my-agent-team/agent";
import type { ModelRegistry, ProviderAuth } from "@my-agent-team/ai";
import type { Message, MessageRevision } from "@my-agent-team/message";
import {
  deserializeLedgerContent,
  extractText,
  isTerminalMessageState,
  serializeMessageRevision,
  systemMessageId,
} from "@my-agent-team/message";
import { createModel, resolveModel } from "../span/agent-helpers.js";
import type { ConversationPort } from "./ports.js";
import { escapeRegExp, getOrCreateAccumulator } from "./run-accumulator.js";
import { buildTitleContext, generateTitle } from "./title.js";

export interface ProjectionDeps {
  convPort: ConversationPort;
  modelRegistry: ModelRegistry;
  auth: ProviderAuth;
}

const titlingInFlight = new Set<string>();

export function createAgentProjection(deps: ProjectionDeps) {
  const { convPort, modelRegistry, auth } = deps;

  const mentionCache = new Map<string, RegExp>();
  const getMentionRe = (label: string) => {
    let re = mentionCache.get(label);
    if (!re) {
      re = new RegExp(`@${escapeRegExp(label)}(?=\\s|[,.!?;:]|$)`, "g");
      mentionCache.set(label, re);
    }
    return re;
  };

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

  const handleAssistantMessage = async (
    conversationId: string,
    agentMemberId: string,
    spanId: string,
    rev: MessageRevision,
    appendFn: (params: {
      conversationId: string;
      senderMemberId: string;
      spanId: string;
      revision: MessageRevision;
    }) => Promise<number>,
  ) => {
    await appendFn({
      conversationId,
      senderMemberId: agentMemberId,
      spanId,
      revision: rev,
    });

    const acc = getOrCreateAccumulator(spanId, agentMemberId);
    if (rev.role === "assistant") {
      acc.latestAssistantRevision = { ...rev, conversationId };
      if (isTerminalMessageState(rev.state)) {
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

  function subscribeToAgent(
    session: Agent,
    conversationId: string,
    agentMemberId: string,
    spanId: string,
    convPortRef: ConversationPort,
    appendFn: (params: {
      conversationId: string;
      senderMemberId: string;
      spanId: string;
      revision: MessageRevision;
    }) => Promise<number>,
  ) {
    session.subscribe((event) => {
      if (event.type === "message_update" || event.type === "message") {
        const rev = event.payload as MessageRevision;
        void handleAssistantMessage(
          conversationId,
          agentMemberId,
          rev.spanId ?? spanId,
          rev,
          appendFn,
        );
      }
      if (event.type === "queue_update") {
        const ts = Date.now();
        const serialized = serializeMessageRevision({
          messageId: systemMessageId(conversationId, "queue"),
          role: "system",
          state: "done",
          text: JSON.stringify({
            type: "queue_update",
            steering: (event as { steering?: unknown }).steering,
            followUp: (event as { followUp?: unknown }).followUp,
          }),
          conversationId,
          visibility: "conversation",
          updatedAt: ts,
        });
        void convPortRef.appendLedgerEntry({
          conversationId,
          senderMemberId: "__system__",
          addressedTo: [],
          kind: "message",
          content: serialized,
          ts,
        });
      }
      if (event.type === "todo_update") {
        const acc = getOrCreateAccumulator(
          (event as { spanId?: string }).spanId ?? spanId,
          agentMemberId,
        );
        acc.lastTodoUpdate = {
          todos: (event as { payload: { todos: Array<{ step: string; status: string }> } }).payload
            .todos,
        };
      }
      if (event.type === "pet_bark") {
        const ts = Date.now();
        void convPortRef.appendLedgerEntry({
          conversationId,
          senderMemberId: agentMemberId,
          addressedTo: [],
          kind: "pet_bark",
          content: JSON.stringify((event as { payload: unknown }).payload),
          ts,
          spanId,
        });
      }
      if (event.type === "recap_update") {
        const ts = Date.now();
        void convPortRef.appendLedgerEntry({
          conversationId,
          senderMemberId: agentMemberId,
          addressedTo: [],
          kind: "recap",
          content: JSON.stringify((event as { payload: unknown }).payload),
          ts,
          spanId,
        });
      }
    });
  }

  return { handleAssistantMessage, subscribeToAgent };
}
