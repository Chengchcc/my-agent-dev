import { Elysia, t } from "elysia";
import { KnowledgePackNotFoundError, type KnowledgeService } from "./service.js";

/** Knowledge pack install pool (ADR 0022). Per-agent switches ride the
 *  agent update API (agent.yml knowledge_packs). */
export function knowledgeRoutes(svc: KnowledgeService) {
  return new Elysia()
    .get("/api/knowledge-packs/:id/stats", ({ params }) => {
      return svc.stats(params.id);
    })
    .get("/api/knowledge-packs", () => {
      return { packs: svc.list() };
    })
    .post(
      "/api/knowledge-packs/install",
      async ({ body, set }) => {
        try {
          const pack = await svc.install(body);
          set.status = 201;
          return { pack };
        } catch (e) {
          if (e instanceof KnowledgePackNotFoundError)
            return Response.json({ error: e.message }, { status: 404 });
          throw e;
        }
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          description: t.Optional(t.String()),
          sourceKind: t.Union([t.Literal("builtin"), t.Literal("git"), t.Literal("zip")]),
          sourceUrl: t.Optional(t.String()),
          versionRef: t.Optional(t.String()),
        }),
      },
    )
    .delete("/api/knowledge-packs/:id", async ({ params: { id }, set }) => {
      try {
        await svc.delete(id);
        set.status = 204;
        return new Response(null, { status: 204 });
      } catch (e) {
        if (e instanceof KnowledgePackNotFoundError)
          return Response.json({ error: e.message }, { status: 404 });
        throw e;
      }
    });
}
