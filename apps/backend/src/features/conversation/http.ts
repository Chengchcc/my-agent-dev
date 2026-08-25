import { conversationEvents, createSseEncoder } from "@chengchenccc/api-contract";
import { extractText, MessageRevisionSchema } from "@chengchenccc/message";
import { Elysia, t } from "elysia";
import { sseResponse } from "../../http/response.js";
import type { GoalStateStore } from "./goal-state.js";
import type { LedgerEntry } from "./ports.js";
import type { ConversationService } from "./service.js";

/** Map a storage LedgerEntry to the wire ConversationEvent (1:1 collapse:
 *  content arrives server-parsed; message-kind rows validate as
 *  MessageRevision, everything else rides as payload). */
function toConversationEvent(entry: LedgerEntry) {
  let raw: unknown;
  try {
    raw = typeof entry.content === "string" ? JSON.parse(entry.content) : entry.content;
  } catch {
    raw = undefined; // heartbeat frames carry content: ""
  }
  if (entry.kind === "message" && raw !== undefined && raw !== null) {
    const rev = MessageRevisionSchema.safeParse(raw);
    if (rev.success) {
      return {
        seq: entry.seq,
        kind: entry.kind,
        message: rev.data,
        ...(entry.undone ? { undone: true } : {}),
      };
    }
  }
  return {
    seq: entry.seq,
    kind: entry.kind,
    ...(raw === undefined ? {} : { payload: raw }),
    ...(entry.undone ? { undone: true } : {}),
  };
}

export function conversationRoutes(
  svc: ConversationService,
  idGen: () => string,
  goalStore: GoalStateStore,
  projectExists?: (id: string) => boolean,
) {
  return (
    new Elysia()
      .get("/api/conversations", ({ query: { agentId } }) => {
        const conversations = agentId
          ? svc.port.listConversationsByAgent(agentId)
          : svc.port.listConversations();
        return conversations;
      })
      .post(
        "/api/conversations",
        async ({ body, set }) => {
          const conversationId = body.conversationId ?? idGen();
          const now = Date.now();
          if (body.projectId && projectExists && !projectExists(body.projectId)) {
            return Response.json({ error: `unknown project ${body.projectId}` }, { status: 400 });
          }
          svc.port.createConversation({
            conversationId,
            agentId: body.agentId,
            createdAt: now,
            projectId: body.projectId ?? null,
          });
          set.status = 201;
          return { conversationId, agentId: body.agentId };
        },
        {
          body: t.Object({
            conversationId: t.Optional(t.String({ minLength: 1 })),
            projectId: t.Optional(t.String({ minLength: 1 })),
            agentId: t.Optional(t.String({ minLength: 1 })),
          }),
        },
      )
      .get(
        "/api/conversations/search",
        ({ query }) => {
          const results = svc.port.searchLedger(query.q, query.limit ? Number(query.limit) : 20);
          return { results };
        },
        {
          query: t.Object({
            q: t.String({ minLength: 1 }),
            limit: t.Optional(t.String()),
          }),
        },
      )
      .get("/api/conversations/:id", ({ params: { id } }) => {
        const conv = svc.port.getConversation(id);
        if (!conv) return Response.json({ error: "Not found" }, { status: 404 });
        return {
          conversationId: conv.conversationId,
          agentId: conv.agentId,
          origin: conv.origin,
          hopCount: conv.hopCount,
          title: conv.title,
          createdAt: conv.createdAt,
          forkSource: conv.forkSource,
          projectId: conv.projectId,
          forkFromSeq: conv.forkFromSeq,
          lastActivityAt: svc.port.getLastActivityAt?.(id) ?? null,
          lastMessagePreview: svc.port.getLastMessagePreview?.(id) ?? null,
        };
      })
      .delete("/api/conversations/:id", async ({ params: { id }, set }) => {
        const deleted = await svc.port.deleteConversation(id);
        if (!deleted) return Response.json({ error: "Not found" }, { status: 404 });
        set.status = 204;
        return "";
      })
      .post(
        "/api/conversations/:id/messages",
        async ({ params: { id: conversationId }, body, set }) => {
          const result = await svc.postMessage({
            conversationId,
            senderMemberId: body.senderMemberId,
            addressedTo: body.addressedTo,
            content: body.content,
            mode: body.mode,
            modelOverride: body.model,
          });
          set.status = 202;
          return result;
        },
        {
          body: t.Object({
            senderMemberId: t.Optional(t.String({ minLength: 1 })),
            addressedTo: t.Optional(t.Array(t.String())),
            content: t.Any(),
            mode: t.Optional(
              t.Union([t.Literal("normal"), t.Literal("steer"), t.Literal("follow_up")]),
            ),
            model: t.Optional(
              t.Object({
                backendKind: t.String(),
                modelId: t.String(),
                reasoningEffort: t.Optional(
                  t.Union([
                    t.Literal("none"),
                    t.Literal("low"),
                    t.Literal("high"),
                    t.Literal("max"),
                  ]),
                ),
              }),
            ),
          }),
        },
      )
      // ── Pending input queue (Composer queue area) ──
      .get("/api/conversations/:id/inputs", async ({ params: { id: conversationId } }) => {
        const inputs = await svc.listPendingInputs(conversationId);
        return { inputs };
      })
      .post("/api/conversations/:id/inputs/:inputId/steer", async ({ params: { inputId } }) => {
        try {
          await svc.steerInput(inputId);
          return { ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "Input not found") return Response.json({ error: msg }, { status: 404 });
          return Response.json({ error: msg }, { status: 409 });
        }
      })
      .patch(
        "/api/conversations/:id/inputs/:inputId",
        async ({ params: { inputId }, body }) => {
          const updated = await svc.updateInput(inputId, body.text);
          if (!updated)
            return Response.json({ error: "Input is no longer pending" }, { status: 409 });
          return { ok: true };
        },
        { body: t.Object({ text: t.String({ minLength: 1 }) }) },
      )
      .post("/api/conversations/:id/inputs/:inputId/cancel", async ({ params: { inputId } }) => {
        await svc.cancelInput(inputId);
        return { ok: true };
      })
      .post("/api/conversations/:id/clear", async ({ params: { id } }) => {
        await svc.clearConversation(id);
        return { ok: true };
      })
      .post("/api/conversations/:id/compact", async ({ params: { id } }) => {
        await svc.compactConversation(id);
        return { ok: true };
      })
      .patch(
        "/api/conversations/:id",
        async ({ params: { id }, body }) => {
          if (body.title !== undefined) {
            svc.port.setConversationTitle(id, body.title);
          }
          return { ok: true };
        },
        {
          body: t.Object({ title: t.Optional(t.String()) }),
        },
      )
      // SSE — returns raw Response (stream, not typed JSON)
      .get("/api/conversations/:id/events", ({ request, params: { id: conversationId } }) => {
        const req = request;
        const qsAfterSeq = new URL(req.url).searchParams.get("afterSeq");
        const afterSeq = qsAfterSeq
          ? parseInt(qsAfterSeq, 10) || 0
          : parseInt(req.headers.get("Last-Event-ID") ?? "0", 10) || 0;
        const stream = svc.subscribeConversation(conversationId, { afterSeq, signal: req.signal });
        const encodeConv = createSseEncoder(conversationEvents);
        return sseResponse(
          stream,
          (entry) => {
            const wire = toConversationEvent(entry);
            return encodeConv(
              entry.kind as keyof typeof conversationEvents,
              wire,
              String(entry.seq),
            );
          },
          req.signal,
        );
      })
      .get("/api/conversations/:id/export", async ({ params: { id } }) => {
        const entries = svc.port.getLedgerEntries(id);
        const conv = svc.port.getConversation(id);
        const title = conv?.title || id;
        const lines: string[] = [`# ${title}`, ""];
        for (const e of entries) {
          if (e.kind !== "message") continue;
          const ts = new Date(e.ts).toISOString();
          const sender = e.senderMemberId === "__system__" ? "System" : e.senderMemberId;
          let text: string;
          try {
            // Drizzle's select schema auto-parses content from JSON string to object.
            const parsed = typeof e.content === "string" ? JSON.parse(e.content) : e.content;
            text =
              typeof parsed === "string" ? parsed : extractText(parsed) || JSON.stringify(parsed);
          } catch {
            text = String(e.content);
          }
          lines.push(`## ${ts}`, `**${sender}**: ${text}`, "");
        }
        const md = lines.join("\n");
        return new Response(md, { headers: { "content-type": "text/markdown" } });
      })
      .post(
        "/api/conversations/:id/start-new",
        async ({ params: { id: conversationId }, body, set }) => {
          try {
            const result = await svc.startNewConversationForSurface({
              oldConversationId: conversationId,
              ...body,
            });
            set.status = 201;
            return result;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("run not found") || msg.includes("does not belong"))
              return Response.json({ error: msg }, { status: 404 });
            throw err;
          }
        },
        {
          body: t.Object({
            reason: t.String({ minLength: 1 }),
            title: t.Optional(t.String()),
            requestedByRunId: t.String({ minLength: 1 }),
            idempotencyKey: t.String({ minLength: 1 }),
          }),
        },
      )
      // ── Fork / Undo / Replay ──
      .post(
        "/api/conversations/:id/fork",
        async ({ params: { id }, body, set }) => {
          const result = await svc.forkConversation({ conversationId: id, ...body });
          set.status = 201;
          return result;
        },
        { body: t.Object({ fromSeq: t.Number(), title: t.Optional(t.String()) }) },
      )
      .post(
        "/api/conversations/:id/undo",
        async ({ params: { id }, body }) => {
          return await svc.undoMessages({ conversationId: id, ...body });
        },
        { body: t.Object({ count: t.Optional(t.Number()) }) },
      )
      .post(
        "/api/conversations/:id/replay",
        async ({ params: { id }, body, set }) => {
          const result = await svc.replayFromMessage({ conversationId: id, ...body });
          set.status = 201;
          return result;
        },
        {
          body: t.Object({
            fromSeq: t.Number(),
            editedContent: t.String(),
            senderMemberId: t.Optional(t.String()),
            addressedTo: t.Optional(t.Array(t.String())),
          }),
        },
      )
      // ── Goal state management ──
      .get("/api/conversations/:id/goal", ({ params: { id } }) => {
        const state = goalStore.get(id);
        return {
          condition: state.condition,
          paused: state.paused,
          turns: state.turns,
          tokens: state.tokens,
          lastReason: state.history[state.history.length - 1]?.reason ?? null,
        };
      })
      .post(
        "/api/conversations/:id/goal",
        async ({ params: { id }, body }) => {
          switch (body.action) {
            case "set":
              goalStore.savePersistent(id, body.condition!, false);
              break;
            case "clear":
              goalStore.clear(id);
              break;
            case "pause":
              goalStore.savePersistent(id, goalStore.get(id).condition, true);
              break;
            case "resume":
              goalStore.savePersistent(id, goalStore.get(id).condition, false);
              break;
          }
          return { ok: true };
        },
        {
          body: t.Object({
            action: t.Union([
              t.Literal("set"),
              t.Literal("clear"),
              t.Literal("pause"),
              t.Literal("resume"),
            ]),
            condition: t.Optional(t.String()),
          }),
        },
      )
  );
}
