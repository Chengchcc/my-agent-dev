import type { Database } from "bun:sqlite";
import { ConversationEvent } from "@chengchenccc/api-contract";
import {
  isTerminalMessageState,
  MessageStateSchema,
  parseMessageRevision,
} from "@chengchenccc/message";
import { z } from "zod";
import {
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
              // Wire DTO is zod-validated here (ConversationEvent); message
              // frames arrive server-parsed — no ledger content dance.
              const event = ConversationEvent.parse(JSON.parse(currentData));
              await processEntry(event, conversationId, larkChatId, db, afterSeq, {
                onSend,
                onRebind,
                sendTextOnly,
              });
              if (event.seq > afterSeq) afterSeq = event.seq;
            } catch (err) {
              // ZodError / SyntaxError are skippable — a structurally invalid
              // frame must not trigger a reconnect loop.
              if (err instanceof SyntaxError || (err as Error)?.name === "ZodError") {
                console.error(
                  `[sse-watcher] malformed conversation event for ${conversationId}, skipping: ${
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
  event: z.infer<typeof ConversationEvent>,
  conversationId: string,
  larkChatId: string,
  db: Database,
  currentSeq: number,
  h: {
    onSend: (chatId: string, text: string, idempotencyKey: string) => Promise<void>;
    onRebind?: (oldConversationId: string, newConversationId: string) => void;
    sendTextOnly?: (chatId: string, text: string) => Promise<void>;
  },
): Promise<void> {
  if (event.seq <= currentSeq) return;

  // ─── surface.control (payload arrives server-parsed; validated here) ───
  if (event.kind === "surface.control") {
    const SurfaceControlSchema = z.object({
      type: z.string(),
      oldConversationId: z.string(),
      newConversationId: z.string(),
    });
    const parsed = SurfaceControlSchema.safeParse(event.payload);
    if (!parsed.success) {
      console.error(
        `[sse-watcher] malformed surface.control at seq=${event.seq}:`,
        parsed.error.message,
      );
      updatePushedSeq(db, larkChatId, event.seq);
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
      updatePushedSeq(db, larkChatId, event.seq);
      if (wasRebound) {
        console.log(
          `[sse-watcher] rebind ${larkChatId}: ${control.oldConversationId} → ${control.newConversationId}`,
        );
        h.onRebind?.(control.oldConversationId, control.newConversationId);
        if (h.sendTextOnly) void h.sendTextOnly(larkChatId, "已开启新的对话。");
      }
    } else {
      updatePushedSeq(db, larkChatId, event.seq);
    }
    return;
  }
  // Non-message frames, system authorship, and human echo (role=user — the
  // human's own words are already visible in the chat) advance seq only.
  // parseMessageRevision normalizes the wire zod type (nullable legacy
  // fields) into the canonical MessageRevision; cannot fail after zod.
  const revision = event.message ? parseMessageRevision(event.message) : undefined;
  if (
    event.kind !== "message" ||
    !revision ||
    revision.role === "system" ||
    revision.role === "user"
  ) {
    updatePushedSeq(db, larkChatId, event.seq);
    return;
  }

  const messageId = revision.messageId;

  // Check delivery state: if already delivered as terminal, skip
  const delivery = getMessageDelivery(db, conversationId, messageId, larkChatId);
  if (delivery && isTerminalMessageState(MessageStateSchema.parse(delivery.lastState))) {
    updatePushedSeq(db, larkChatId, event.seq);
    return;
  }

  // M17.5 P3: Record delivery intent BEFORE sending (idempotency).
  // If onSend throws, the delivery record is already persisted, so reconnection
  // won't re-send (it hits the terminal-state guard above).
  upsertMessageDelivery(db, {
    conversationId,
    messageId,
    larkChatId,
    lastState: revision.state,
    lastSeq: event.seq,
    updatedAt: Date.now(),
  });

  // Render and send (canonical History only carries terminal frames; there
  // is no streaming revision path in Phase 5). L6: retry with backoff.
  const text = renderRevision(revision);
  const idempotencyKey = `${conversationId}:${messageId}:${event.seq}`;

  let attempt = 0;
  while (attempt < 3) {
    try {
      await h.onSend(larkChatId, text, idempotencyKey);
      break;
    } catch (err) {
      attempt++;
      if (attempt >= 3) {
        console.error(`[lark] send failed after ${attempt} attempts, skip seq=${event.seq}`, err);
        break; // don't kill the SSE stream
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }

  updatePushedSeq(db, larkChatId, event.seq);
}
