import { Elysia, t } from "elysia";
import type { ArtifactService } from "./service.js";

export function artifactRoutes(service: ArtifactService) {
  return new Elysia({ prefix: "/api/artifacts" })
    .get(
      "/",
      async ({ query }) => {
        const folder = query.folder ? String(query.folder) : undefined;
        return { artifacts: await service.list(folder) };
      },
      {
        query: t.Object({ folder: t.Optional(t.String()) }),
      },
    )
    .get(
      "/download",
      async ({ query }) => {
        return service.download(query.url);
      },
      {
        query: t.Object({ url: t.String({ minLength: 1 }) }),
      },
    )
    .get(
      "/:url",
      async ({ params }) => {
        const url = decodeURIComponent(params.url);
        return service.download(url);
      },
      {
        params: t.Object({ url: t.String() }),
      },
    )
    .post(
      "/",
      async ({ body, set }) => {
        const meta = await service.upload({
          folder: body.folder,
          filename: body.filename,
          content: body.content,
          encoding: body.encoding,
          source: body.source,
        });
        set.status = 201;
        return meta;
      },
      {
        body: t.Object({
          folder: t.String(),
          filename: t.String(),
          content: t.String(),
          encoding: t.Optional(t.Union([t.Literal("utf8"), t.Literal("base64")])),
          source: t.Optional(
            t.Object({
              runId: t.Optional(t.String()),
              conversationId: t.Optional(t.String()),
              agentId: t.Optional(t.String()),
            }),
          ),
        }),
      },
    )
    .delete(
      "/:url",
      async ({ params }) => {
        const url = decodeURIComponent(params.url);
        const ok = await service.delete(url);
        return { ok };
      },
      {
        params: t.Object({ url: t.String() }),
      },
    );
}
