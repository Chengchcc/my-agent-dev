import { Elysia, t } from "elysia";
import { ConflictError } from "../../infra/domain-errors.js";
import { ProjectNotFoundError, type ProjectService, ValidationError } from "./service.js";
import type { WorktreeOps } from "./worktree-ops.js";

export function projectRoutes(svc: ProjectService, worktreeOps?: WorktreeOps) {
  return new Elysia()
    .get("/api/projects", () => ({ projects: svc.list() }))
    .post(
      "/api/projects",
      ({ body, set }) => {
        try {
          const project = svc.createProject(body);
          set.status = 201;
          return { project };
        } catch (err) {
          if (err instanceof ValidationError)
            return Response.json({ error: err.message }, { status: 400 });
          throw err;
        }
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          repoUrl: t.Optional(t.String()),
          defaultBranch: t.Optional(t.String()),
        }),
      },
    )
    .get("/api/projects/:id", ({ params: { id } }) => {
      try {
        return { project: svc.getById(id) };
      } catch (err) {
        if (err instanceof ProjectNotFoundError)
          return Response.json({ error: err.message }, { status: 404 });
        if (err instanceof ConflictError)
          return Response.json({ error: err.message }, { status: 409 });
        throw err;
      }
    })
    .patch(
      "/api/projects/:id",
      ({ params: { id }, body }) => {
        try {
          const project = svc.update(id, body);
          return { project };
        } catch (err) {
          if (err instanceof ProjectNotFoundError)
            return Response.json({ error: err.message }, { status: 404 });
          if (err instanceof ValidationError)
            return Response.json({ error: err.message }, { status: 400 });
          throw err;
        }
      },
      {
        body: t.Object({
          name: t.Optional(t.String()),
          repoUrl: t.Optional(t.Union([t.String(), t.Null()])),
          defaultBranch: t.Optional(t.Union([t.String(), t.Null()])),
        }),
      },
    )
    .get("/api/projects/:id/worktrees", async ({ params: { id } }) => {
      if (!worktreeOps) {
        return Response.json({ error: "worktree ops unavailable" }, { status: 501 });
      }
      try {
        return { worktrees: await worktreeOps.status(id) };
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return Response.json({ error: err.message }, { status: 404 });
        }
        throw err;
      }
    })
    .get("/api/projects/:id/worktrees/:agentId/diff", async ({ params: { id, agentId } }) => {
      if (!worktreeOps) {
        return Response.json({ error: "worktree ops unavailable" }, { status: 501 });
      }
      try {
        return { diff: await worktreeOps.diff(id, agentId) };
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return Response.json({ error: err.message }, { status: 404 });
        }
        throw err;
      }
    })
    .post(
      "/api/projects/:id/worktrees/:agentId/fast-forward",
      async ({ params: { id, agentId }, body }) => {
        if (!worktreeOps) {
          return Response.json({ error: "worktree ops unavailable" }, { status: 501 });
        }
        try {
          await worktreeOps.fastForward(id, agentId, { push: body.push === true });
          return { ok: true };
        } catch (err) {
          if (err instanceof ConflictError) {
            return Response.json({ error: err.message }, { status: 409 });
          }
          throw err;
        }
      },
      { body: t.Object({ push: t.Optional(t.Boolean()) }) },
    )
    .post(
      "/api/projects/:id/worktrees/:agentId/merge",
      async ({ params: { id, agentId }, body }) => {
        if (!worktreeOps) {
          return Response.json({ error: "worktree ops unavailable" }, { status: 501 });
        }
        try {
          await worktreeOps.merge(id, agentId, { push: body.push === true });
          return { ok: true };
        } catch (err) {
          if (err instanceof ConflictError) {
            return Response.json({ error: err.message }, { status: 409 });
          }
          throw err;
        }
      },
      { body: t.Object({ push: t.Optional(t.Boolean()) }) },
    )
    .delete("/api/projects/:id", async ({ params: { id }, set }) => {
      try {
        await svc.remove(id);
        set.status = 204;
        return "";
      } catch (err) {
        if (err instanceof ProjectNotFoundError)
          return Response.json({ error: err.message }, { status: 404 });
        throw err;
      }
    });
}
