import { Elysia, t } from "elysia";
import type { RuntimeOpsService } from "./service.js";

/** Surface-health audit endpoints only. Run execution state lives under
 *  /api/agent-runs (Agent Run is the sole execution identity). */
export function opsRoutes(svc: RuntimeOpsService) {
  return new Elysia()
    .get("/api/ops/agents/:id/runtime", ({ params: { id } }) => svc.getAgentRuntime(id))
    .get("/api/ops/surfaces", () => svc.listSurfaces())
    .post(
      "/api/internal/surfaces/lark/heartbeat",
      ({ body }) => {
        svc.ingestLarkHeartbeat(body);
        return { ok: true };
      },
      {
        body: t.Object({
          agentId: t.String(),
          status: t.String(),
          payload: t.Optional(t.Record(t.String(), t.Any())),
          lastError: t.Optional(t.String()),
        }),
      },
    );
}
