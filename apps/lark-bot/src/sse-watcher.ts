import type { Database } from "bun:sqlite";
import { type LedgerEntry, parseLedgerEntry } from "@my-agent-team/conversation";
import {
  deserializeLedgerContent,
  isTerminalMessageState,
  MessageStateSchema,
  type parseMessageRevision,
} from "@my-agent-team/message";
import { z } from "zod";
import {
  getMemberBindingsForChat,
  getMessageDelivery,
  rebindChatConversation,
  updatePushedSeq,
  upsertMessageDelivery,
} from "./bindings-sqlite.js";
import { renderRevision } from "./render.js";

export interface SseWatcherDeps {
  db: Database;
  backendUrl: string;
  backendAuthToken: string | null;
  onSend: (chatId: string, text: string, idempotencyKey: string) => Promise<void>;
  onRebind?: (oldConversationId: string, newConversationId: string) => void;
  sendTextOnly?: (chatId: string, text: string) => Promise<void>;
}

export interface WatcherHandle {
  conversationId: string;
  close: () => void;
}

export function watchConversation(
  conversationId: string,
  larkChatId: string,
  afterSeq: number,
  deps: SseWatcherDeps,
): WatcherHandle {
  const { db, backendUrl, backendAuthToken, onSend, onRebind, sendTextOnly } = deps;
  const reqHeaders: Record<string, string> = { Accept: "text/event-stream" };
  if (backendAuthToken) reqHeaders["x-auth-token"] = backendAuthToken;
  let aborted = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReconnect(delayMs: number) {
    if (aborted) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void run();
    }, delayMs);
  }

  const run = async () => {
    if (aborted) return;
    // L5: use afterSeq query param + Last-Event-ID header for proper SSE reconnect
    const url = `${backendUrl}/api/conversations/${conversationId}/events?afterSeq=${afterSeq}`;
    const headers = { ...reqHeaders };
    if (afterSeq > 0) headers["Last-Event-ID"] = String(afterSeq);

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      const resp = await fetch(url, { headers });

      if (!resp.ok || !resp.body) {
        console.error(`[sse-watcher] failed to connect: ${resp.status}`);
        scheduleReconnect(5000);
        return;
      }

      reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentData = "";

      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) {
          scheduleReconnect(1000);
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            currentData += currentData ? `\n${line.slice(6)}` : line.slice(6);
          } else if (line === "" && currentData) {
            try {
              // M17.3: use codec instead of bare JSON.parse + as
              const entry = parseLedgerEntry(JSON.parse(currentData));
              await processEntry(entry, larkChatId, db, afterSeq, {
                onSend,
                onRebind,
                sendTextOnly,
              });
              if (entry.seq > afterSeq) afterSeq = entry.seq;
            } catch (err) {
              // M17.3 fix: ZodError (from parseLedgerEntry) is skippable, same as SyntaxError.
              // A structurally invalid frame must not trigger a reconnect loop.
              if (err instanceof SyntaxError || (err as Error)?.name === "ZodError") {
                console.error(
                  `[sse-watcher] malformed ledger entry for ${conversationId}, skipping: ${
                    (err as Error).message
                  }`,
                );
              } else {
                console.error(
                  `[sse-watcher] process entry failed for ${conversationId}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
                throw err;
              }
            }
            currentData = "";
          }
        }
      }
    } catch (err) {
      console.error(`[sse-watcher] connection error for ${conversationId}:`, err);
      scheduleReconnect(5000);
    } finally {
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          /* cleanup */
        }
        try {
          reader.releaseLock();
        } catch {
          /* cleanup */
        }
      }
    }
  };

  run();

  return {
    conversationId,
    close: () => {
      aborted = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    },
  };
}

async function processEntry(
  entry: LedgerEntry,
  larkChatId: string,
  db: Database,
  currentSeq: number,
  h: {
    onSend: (chatId: string, text: string, idempotencyKey: string) => Promise<void>;
    onRebind?: (oldConversationId: string, newConversationId: string) => void;
    sendTextOnly?: (chatId: string, text: string) => Promise<void>;
  },
): Promise<void> {
  if (entry.seq <= currentSeq) return;

  // ─── surface.control (L8: validated with zod) ───
  if (entry.kind === "surface.control") {
    const SurfaceControlSchema = z.object({
      type: z.string(),
      oldConversationId: z.string(),
      newConversationId: z.string(),
    });
    const parsed = SurfaceControlSchema.safeParse(JSON.parse(entry.content));
    if (!parsed.success) {
      console.error(
        `[sse-watcher] malformed surface.control at seq=${entry.seq}:`,
        parsed.error.message,
      );
      updatePushedSeq(db, larkChatId, entry.seq);
      return;
    }
    const control = parsed.data;
    if (
      control.type === "lark.start_new_conversation" &&
      control.oldConversationId &&
      control.newConversationId
    ) {
      const wasRebound = rebindChatConversation(
        db,
        larkChatId,
        control.oldConversationId,
        control.newConversationId,
      );
      updatePushedSeq(db, larkChatId, entry.seq);
      if (wasRebound) {
        console.log(
          `[sse-watcher] rebind ${larkChatId}: ${control.oldConversationId} → ${control.newConversationId}`,
        );
        h.onRebind?.(control.oldConversationId, control.newConversationId);
        if (h.sendTextOnly) void h.sendTextOnly(larkChatId, "已开启新的对话。");
      }
    } else {
      updatePushedSeq(db, larkChatId, entry.seq);
    }
    return;
  }

  // Non-message, system → advance seq only
  if (entry.kind !== "message" || entry.senderMemberId === "__system__") {
    updatePushedSeq(db, larkChatId, entry.seq);
    return;
  }

  // Human echo → skip
  const isHumanOfThisChat = getMemberBindingsForChat(db, larkChatId).some(
    (m) => m.memberId === entry.senderMemberId,
  );
  if (isHumanOfThisChat) {
    updatePushedSeq(db, larkChatId, entry.seq);
    return;
  }

  // ─── M17.1: Message revision model with error isolation ───
  // Parse errors are non-retryable data errors — skip the entry and advance seq
  // so a single bad entry doesn't permanently block the watcher.
  let revision: ReturnType<typeof parseMessageRevision>;
  try {
    const result = deserializeLedgerContent(entry.content);
    if (!("messageId" in result)) throw new Error("not a message revision");
    revision = result;
  } catch (err) {
    console.error(
      `[sse-watcher] invalid message revision at seq=${entry.seq}, conversation=${entry.conversationId}, skipping: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    updatePushedSeq(db, larkChatId, entry.seq);
    return;
  }

  const messageId = revision.messageId;

  // Check delivery state: if already delivered as terminal, skip
  const delivery = getMessageDelivery(db, entry.conversationId, messageId, larkChatId);
  if (delivery && isTerminalMessageState(MessageStateSchema.parse(delivery.lastState))) {
    updatePushedSeq(db, larkChatId, entry.seq);
    return;
  }

  // M17.5 P3: Record delivery intent BEFORE sending (idempotency).
  // If onSend throws, the delivery record is already persisted, so reconnection
  // won't re-send (it hits the terminal-state guard above).
  upsertMessageDelivery(db, {
    conversationId: entry.conversationId,
    messageId,
    larkChatId,
    lastState: revision.state,
    lastSeq: entry.seq,
    updatedAt: Date.now(),
  });

  // Render and send (canonical History only carries terminal frames; there
  // is no streaming revision path in Phase 5). L6: retry with backoff.
  const text = renderRevision(revision);
  const idempotencyKey = `${entry.conversationId}:${messageId}:${entry.seq}`;

  let attempt = 0;
  while (attempt < 3) {
    try {
      await h.onSend(larkChatId, text, idempotencyKey);
      break;
    } catch (err) {
      attempt++;
      if (attempt >= 3) {
        console.error(`[lark] send failed after ${attempt} attempts, skip seq=${entry.seq}`, err);
        break; // don't kill the SSE stream
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }

  updatePushedSeq(db, larkChatId, entry.seq);
}
