import { Elysia, t } from "elysia";
import { McpServerNotFoundError, type McpService, McpValidationError } from "./service.js";

const createBody = t.Object({
  name: t.String({ minLength: 1 }),
  transport: t.Union([t.Literal("stdio"), t.Literal("sse")]),
  command: t.Optional(t.String()),
  args: t.Optional(t.Array(t.String())),
  env: t.Optional(t.Record(t.String(), t.String())),
  url: t.Optional(t.String()),
});

const updateBody = t.Object({
  name: t.Optional(t.String()),
  command: t.Optional(t.String()),
  args: t.Optional(t.Array(t.String())),
  env: t.Optional(t.Record(t.String(), t.String())),
  url: t.Optional(t.String()),
});

/** MCP unified catalog (ADR 0022): global CRUD at /api/mcp-servers.
 *  Per-agent switches live in agent.yml and ride the agent update API. */
export function mcpRoutes(svc: McpService) {
  return new Elysia()
    .get("/api/mcp-servers", () => {
      return { mcpServers: svc.listCatalog() };
    })
    .post(
      "/api/mcp-servers",
      async ({ body, set }) => {
        try {
          const server = await svc.create(body);
          set.status = 201;
          return { mcpServer: server };
        } catch (e) {
          if (e instanceof McpValidationError)
            return Response.json({ error: e.message }, { status: 422 });
          throw e;
        }
      },
      { body: createBody },
    )
    .put(
      "/api/mcp-servers/:serverId",
      async ({ params: { serverId }, body }) => {
        try {
          const server = await svc.update(serverId, body);
          return { mcpServer: server };
        } catch (e) {
          if (e instanceof McpServerNotFoundError)
            return Response.json({ error: e.message }, { status: 404 });
          if (e instanceof McpValidationError)
            return Response.json({ error: e.message }, { status: 422 });
          throw e;
        }
      },
      { body: updateBody },
    )
    .delete("/api/mcp-servers/:serverId", async ({ params: { serverId }, set }) => {
      try {
        await svc.delete(serverId);
        set.status = 204;
        return new Response(null, { status: 204 });
      } catch (e) {
        if (e instanceof McpServerNotFoundError)
          return Response.json({ error: e.message }, { status: 404 });
        throw e;
      }
    });
}
