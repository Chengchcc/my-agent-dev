import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { conversationRoutes } from "./http.js";
import type { ConversationRow } from "./ports.js";
import type { ConversationService } from "./service.js";

/** Minimal in-memory port double for the POST /api/conversations path. */
function makeSvc() {
  const rows = new Map<string, ConversationRow>();
  const port = {
    createConversation(input: { conversationId: string; agentId?: string | null }) {
      const row: ConversationRow = {
        conversationId: input.conversationId,
        agentId: input.agentId ?? "default",
        hopCount: 0,
        createdAt: 0,
        title: null,
        origin: "user",
        forkSource: null,
        forkFromSeq: null,
        projectId: null,
      };
      rows.set(input.conversationId, row);
      return row;
    },
    getConversation(id: string) {
      return rows.get(id) ?? null;
    },
    listConversations() {
      return [...rows.values()];
    },
    listConversationsByAgent(id: string) {
      return [...rows.values()].filter((r) => r.agentId === id);
    },
  };
  const svc = { port } as unknown as ConversationService;
  return new Elysia().use(
    conversationRoutes(svc, () => `gen-${Math.random().toString(36).slice(2)}`),
  );
}

function post(app: ReturnType<typeof makeSvc>, body: Record<string, unknown>) {
  return app.handle(
    new Request("http://localhost/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/conversations", () => {
  test("creates a new conversation on first POST", async () => {
    const app = makeSvc();
    const res = await post(app, { conversationId: "c1", agentId: "default", origin: "workflow" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { conversationId?: string }).conversationId).toBe("c1");
  });

  test("is idempotent: POSTing an existing conversationId returns 200, no dup", async () => {
    const app = makeSvc();
    await post(app, {
      conversationId: "workflow:chat:seed",
      agentId: "default",
      origin: "workflow",
    });
    const second = await post(app, {
      conversationId: "workflow:chat:seed",
      agentId: "default",
      origin: "workflow",
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { conversationId?: string }).conversationId).toBe(
      "workflow:chat:seed",
    );
    const listRes = await app.handle(
      new Request("http://localhost/api/conversations", { method: "GET" }),
    );
    const list = (await listRes.json()) as Array<{ conversationId: string }>;
    expect(list.filter((c) => c.conversationId === "workflow:chat:seed")).toHaveLength(1);
  });

  test("auto-generates a conversationId when omitted", async () => {
    const app = makeSvc();
    const res = await post(app, { agentId: "default" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { conversationId?: string }).conversationId).toBeTruthy();
  });
});
