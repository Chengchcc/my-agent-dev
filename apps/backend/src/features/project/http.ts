import { Elysia, t } from "elysia";
import { ProjectNotFoundError, type ProjectService, ValidationError } from "./service.js";

export function projectRoutes(svc: ProjectService) {
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
    .delete("/api/projects/:id", ({ params: { id }, set }) => {
      try {
        svc.remove(id);
        set.status = 204;
        return "";
      } catch (err) {
        if (err instanceof ProjectNotFoundError)
          return Response.json({ error: err.message }, { status: 404 });
        throw err;
      }
    });
}
