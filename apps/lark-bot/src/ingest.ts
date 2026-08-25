import type { Database } from "bun:sqlite";
import {
  confirmInbound,
  getChatBinding,
  getMemberBinding,
  inboundExists,
  putChatBinding,
  putMemberBinding,
  reserveInbound,
} from "./bindings-sqlite.js";
import { createClient } from "./client.js";
import type { LarkMessageEvent } from "./event-parser.js";
import { isBotMentioned } from "./event-parser.js";

export interface IngestContext {
  db: Database;
  selfAgentId: string;
  selfAgentName: string;
  botDisplayName: string | null;
  backendUrl: string;
  backendAuthToken: string | null;
  profile: string;
  /** Called when a new conversation is bound — allows dynamic SSE subscription */
  onNewBinding?: (conversationId: string) => void;
  /** M15.1: Called for each triggered run — starts streaming card lifecycle */
  onTriggeredRun?: (runId: string, conversationId: string, sourceMessageId: string) => void;
}

export interface IngestResult {
  action: "consumed" | "skipped" | "error";
  conversationId?: string;
  ledgerSeq?: number;
  triggered: boolean;
  triggeredRuns: Array<{ agentMemberId: string; runId: string }>;
}

/**
 * Process one Lark message event through the reserve→POST→confirm pipeline.
 * See spec §4.3 for the full pseudocode and rationale.
 */
export async function ingest(event: LarkMessageEvent, ctx: IngestContext): Promise<IngestResult> {
  const {
    db,
    selfAgentId,
    selfAgentName,
    botDisplayName,
    backendUrl,
    backendAuthToken,
    onNewBinding,
  } = ctx;
  const client = createClient(backendUrl, backendAuthToken);

  // ─── Step 0: Idempotent reserve (local sqlite transaction) ───
  // Reserve before POST: if POST succeeds but confirm fails, the event won't re-POST.
  // Trade-off: "lose an inbound rather than duplicate a run trigger" (spec §5.3).
  let memberId = "";
  let conversationId = "";
  // ─── Step 0: Idempotent reserve (local sqlite transaction) ───
  const reserveResult = db.transaction(() => {
    if (inboundExists(db, event.event_id, event.message_id)) {
      return {
        ok: false as const,
        needCreateConv: false as const,
        conversationId: null as string | null,
      };
    }
    reserveInbound(db, event.event_id, event.message_id, event.chat_id);

    // Resolve or create chat binding
    const binding = getChatBinding(db, event.chat_id);
    if (!binding) {
      return {
        ok: true as const,
        needCreateConv: true as const,
        conversationId: null as string | null,
      };
    }
    const cid = binding.conversationId;

    // Resolve or create human member
    let mid = getMemberBinding(db, event.chat_id, event.sender_id);
    if (!mid) {
      mid = `human:lark:${event.sender_id}`;
      putMemberBinding(db, event.chat_id, event.sender_id, mid);
    }
    memberId = mid;
    conversationId = cid;

    return { ok: true as const, needCreateConv: false as const, conversationId: cid };
  })();

  if (!reserveResult.ok) return { action: "skipped", triggered: false, triggeredRuns: [] };

  // ─── Create conversation if needed (HTTP call, outside transaction) ───
  if (reserveResult.needCreateConv) {
    const { data: convData, error: convError } = await client.api.conversations.post({
      members: [
        {
          kind: "agent",
          memberId: selfAgentId,
          agentId: selfAgentId,
          displayName: selfAgentName,
        },
      ],
    });
    if (convError) {
      console.error(`[ingest] create conversation failed: ${JSON.stringify(convError)}`);
      return { action: "error", triggered: false, triggeredRuns: [] };
    }
    if (typeof convData !== "object" || convData === null) {
      console.error("[ingest] create conversation returned non-object");
      return { action: "error", triggered: false, triggeredRuns: [] };
    }
    conversationId = (convData as Record<string, unknown>).conversationId as string;
    memberId = `human:lark:${event.sender_id}`;

    // Add the human member via API FIRST (idempotent per §7.3).
    try {
      const { error: memberError } = await client.api
        .conversations({ id: conversationId })
        .members.post({
          kind: "human",
          memberId,
          userRef: `lark:${event.sender_id}`,
          displayName: event.senderDisplayName ?? event.sender_id,
        });
      if (memberError) {
        console.error(`[ingest] add member failed: ${JSON.stringify(memberError)}`);
        return { action: "error", conversationId, triggered: false, triggeredRuns: [] };
      }
    } catch (err) {
      console.error(`[ingest] add member network error:`, err);
      return { action: "error", conversationId, triggered: false, triggeredRuns: [] };
    }

    // Write local bindings only after /members succeeds
    db.transaction(() => {
      putChatBinding(db, event.chat_id, conversationId, event.chat_type, Date.now());
      putMemberBinding(db, event.chat_id, event.sender_id, memberId);
    })();

    onNewBinding?.(conversationId);
  } else {
    conversationId = reserveResult.conversationId!;
    // memberId was already set during the transaction above
  }

  // ─── Step 1: addressedTo (group @mention routing only) ───
  // p2p omits identity/routing params — the server derives sender (the
  // human member) and targets (the agent member) for 1:1 conversations.
  // Group chats keep explicit values: multiple humans, @mention fail-closed
  // (botDisplayName missing → addressedTo=[] → no trigger, spec §六).
  let addressedTo: string[] | undefined;
  let senderMemberId: string | undefined;
  if (event.chat_type === "p2p") {
    addressedTo = undefined;
  } else if (event.chat_type === "group") {
    senderMemberId = memberId;
    addressedTo =
      botDisplayName && isBotMentioned(event.content, botDisplayName) ? [selfAgentId] : [];
  }

  // ─── Step 2: POST /messages ───
  try {
    const { data: msgData, error: msgError } = await client.api
      .conversations({ id: conversationId })
      .messages.post({
        senderMemberId,
        addressedTo,
        content: {
          text: event.content,
          source: "lark",
          larkEventId: event.event_id,
          larkMessageId: event.message_id,
        },
      });

    if (msgError) {
      console.error(`[ingest] POST /messages failed: ${JSON.stringify(msgError)}`);
      return { action: "error", conversationId, triggered: false, triggeredRuns: [] };
    }
    if (typeof msgData !== "object" || msgData === null) {
      console.error("[ingest] POST /messages returned non-object");
      return { action: "error", conversationId, triggered: false, triggeredRuns: [] };
    }
    const body = msgData as Record<string, unknown>;
    const seq = body.seq as number;
    const triggeredRuns = (body.triggeredRuns ?? []) as Array<{
      agentMemberId: string;
      runId: string;
    }>;

    // ─── Step 3: Confirm inbound (backfill ledger_seq) ───
    db.transaction(() => {
      confirmInbound(db, event.event_id, conversationId, seq);
    })();

    const triggered = (addressedTo?.length ?? 0) > 0 || (triggeredRuns?.length ?? 0) > 0;
    const runs = triggeredRuns ?? [];

    // M15.1: Start streaming card lifecycle for each triggered run
    if (ctx.onTriggeredRun) {
      for (const run of runs) {
        ctx.onTriggeredRun(run.runId, conversationId, event.message_id);
      }
    }

    return {
      action: "consumed",
      conversationId,
      ledgerSeq: seq,
      triggered,
      triggeredRuns: runs,
    };
  } catch (err) {
    console.error("[ingest] error:", err instanceof Error ? err.message : String(err));
    return { action: "error", conversationId, triggered: false, triggeredRuns: [] };
  }
}
