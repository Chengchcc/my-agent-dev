import { conversationEvents, createSseEncoder } from "@my-agent-team/api-contract";
import { Elysia, t } from "elysia";
import { sseResponse } from "../../http/response.js";
import type { GoalStateStore } from "./goal-state.js";
import type { ConversationService } from "./service.js";

export function conversationRoutes(
  svc: ConversationService,
  idGen: () => string,
  goalStore: GoalStateStore,
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
          svc.port.createConversation({
            conversationId,
            triggerMode: body.triggerMode ?? "mention",
            createdAt: now,
          });
          const members = body.members ?? [];
          for (const m of members) {
            await svc.addMember({
              conversationId,
              memberId: m.memberId ?? idGen(),
              kind: m.kind,
              agentId: m.agentId,
              userRef: m.userRef,
              displayName: m.displayName,
            });
          }
          const allMembers = svc.port.getMembers(conversationId);
          set.status = 201;
          return { conversationId, members: allMembers };
        },
        {
          body: t.Object({
            conversationId: t.Optional(t.String({ minLength: 1 })),
            members: t.Optional(
              t.Array(
                t.Object({
                  memberId: t.Optional(t.String({ minLength: 1 })),
                  kind: t.Union([t.Literal("agent"), t.Literal("human")]),
                  agentId: t.Optional(t.String()),
                  userRef: t.Optional(t.String()),
                  displayName: t.Optional(t.String()),
                }),
              ),
            ),
            triggerMode: t.Optional(t.Literal("mention")),
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
        const members = svc.port.getMembers(id);
        return {
          conversationId: conv.conversationId,
          triggerMode: conv.triggerMode,
          hopCount: conv.hopCount,
          title: conv.title,
          createdAt: conv.createdAt,
          forkSource: conv.forkSource,
          forkFromSeq: conv.forkFromSeq,
          lastActivityAt: svc.port.getLastActivityAt?.(id) ?? null,
          members,
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
          });
          set.status = 202;
          return result;
        },
        {
          body: t.Object({
            senderMemberId: t.String({ minLength: 1 }),
            addressedTo: t.Array(t.String()),
            content: t.Any(),
          }),
        },
      )
      .post(
        "/api/conversations/:id/members",
        async ({ params: { id: conversationId }, body }) => {
          const memberId = body.memberId ?? idGen();
          await svc.addMember({
            conversationId,
            memberId,
            kind: body.kind,
            agentId: body.agentId,
            userRef: body.userRef,
            displayName: body.displayName,
          });
          const members = svc.port.getMembers(conversationId);
          return { members };
        },
        {
          body: t.Object({
            memberId: t.Optional(t.String({ minLength: 1 })),
            kind: t.Union([t.Literal("agent"), t.Literal("human")]),
            agentId: t.Optional(t.String()),
            userRef: t.Optional(t.String()),
            displayName: t.Optional(t.String()),
          }),
        },
      )
      .delete(
        "/api/conversations/:id/members",
        async ({ params: { id: conversationId }, body }) => {
          await svc.removeMember(conversationId, body.memberId);
          const members = svc.port.getMembers(conversationId);
          return { members };
        },
        {
          body: t.Object({
            memberId: t.String({ minLength: 1 }),
          }),
        },
      )
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
            const normalized = {
              ...entry,
              content:
                typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content),
            };
            return encodeConv(
              entry.kind as keyof typeof conversationEvents,
              normalized,
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
            const parsed = JSON.parse(e.content);
            text = typeof parsed === "string" ? parsed : parsed.text || JSON.stringify(parsed);
          } catch {
            text = e.content;
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
            senderMemberId: t.String(),
            addressedTo: t.Array(t.String()),
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
