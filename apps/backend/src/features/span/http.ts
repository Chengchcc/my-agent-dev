import type { SessionManager } from "@my-agent-team/agent";
import { Elysia, t } from "elysia";

/**
 * Resume an interrupted run via Agent.resume().
 *
 * Looks up the session by spanId (params.id) → sessionId (via injected getSessionIdByRunId),
 * then retrieves the live session from SessionManager.get (never creates).
 *
 * Session lifecycle is managed by SessionManager; resume does NOT dispose
 * the session — it persists across spans.
 */
export function resumeRoutes(deps: {
  sessionManager: SessionManager;
  getSessionIdByRunId: (spanId: string) => string | null;
}) {
  return new Elysia().post(
    "/api/runs/:id/resume",
    async ({ params: { id }, body }) => {
      const sessionId = deps.getSessionIdByRunId(id);
      if (!sessionId) return Response.json({ error: "Run not found" }, { status: 404 });

      const session = deps.sessionManager.get(sessionId);
      if (!session)
        return Response.json(
          { error: "Session no longer active — already settled" },
          { status: 409 },
        );

      try {
        await session.resume({ approved: body.approved, message: body.message });
        return { spanId: id, resumed: true };
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 500 });
      }
    },
    {
      body: t.Object({
        approved: t.Boolean(),
        message: t.Optional(t.String()),
      }),
    },
  );
}
