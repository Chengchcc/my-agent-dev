import type { BackendModelCatalog } from "@my-agent-team/agent-backend";
import {
  createRunRequestSchema,
  steerRunRequestSchema,
  stopRunRequestSchema,
} from "@my-agent-team/agent-backend";
import { Elysia, t } from "elysia";
import { bearerToken, verifyToken } from "./auth.js";
import { ReplayWindowExceededError, type RunEventBuffer } from "./event-buffer.js";
import type { CodingRunRegistry } from "./run-registry.js";

/** Max queued chunks before a slow SSE subscriber is evicted (its stream is
 *  closed; the run keeps flowing for others). Bounds memory per connection. */
const SLOW_SUBSCRIBER_LIMIT = 64;

export interface RouteDeps {
  registry: CodingRunRegistry;
  authToken: string;
  getModelCatalog(): Promise<BackendModelCatalog>;
}

/** SSE event stream writer. Returns a controller for the connection. */
export function sseEncode(eventId: number, type: string, data: unknown): string {
  const lines = JSON.stringify(data)
    .split("\n")
    .map((l) => `data: ${l}`)
    .join("\n");
  return `id: ${eventId}\nevent: ${type}\n${lines}\n\n`;
}

export function createRoutes(deps: RouteDeps): Elysia {
  const app = new Elysia();

  const requireAuth = (headers: Record<string, string | undefined>): boolean => {
    const candidate = bearerToken(headers.authorization ?? null);
    return verifyToken(deps.authToken, candidate);
  };

  const authGuard = (headers: Record<string, string | undefined>): Response | null => {
    if (!requireAuth(headers)) {
      return Response.json({ code: "unauthorized", message: "unauthorized" }, { status: 401 });
    }
    return null;
  };

  const errorResponse = (err: unknown): Response => {
    if (err instanceof ReplayWindowExceededError) {
      return Response.json(
        { code: "replay_window_exceeded", message: err.message },
        { status: 409 },
      );
    }
    const e = err as { code?: string; message?: string };
    const code = e?.code ?? "internal";
    const status =
      code === "not_found"
        ? 404
        : code === "busy"
          ? 409
          : code === "conflict"
            ? 409
            : code === "invalid_request"
              ? 400
              : 500;
    return Response.json({ code, message: e?.message ?? String(err) }, { status });
  };

  app.get("/health", () => Response.json({ ok: true }));

  app.get("/v1/models", ({ headers }) => {
    const denied = authGuard(headers);
    if (denied) return denied;
    return deps.getModelCatalog();
  });

  app.post(
    "/v1/runs",
    async ({ body, headers }) => {
      const denied = authGuard(headers);
      if (denied) return denied;
      const parsed = createRunRequestSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json(
          { code: "invalid_request", message: parsed.error.message },
          { status: 400 },
        );
      }
      try {
        const result = await deps.registry.execute(parsed.data as never);
        return Response.json(result);
      } catch (err) {
        return errorResponse(err);
      }
    },
    { body: t.Any() },
  );

  app.post(
    "/v1/runs/:runId/steer",
    async ({ params, body, headers }) => {
      const denied = authGuard(headers);
      if (denied) return denied;
      const parsed = steerRunRequestSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json(
          { code: "invalid_request", message: parsed.error.message },
          { status: 400 },
        );
      }
      try {
        await deps.registry.steer(params.runId, parsed.data.input as never);
        return Response.json({ accepted: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
    { body: t.Any() },
  );

  app.post(
    "/v1/runs/:runId/stop",
    async ({ params, body, headers }) => {
      const denied = authGuard(headers);
      if (denied) return denied;
      const parsed = stopRunRequestSchema.safeParse(body ?? {});
      if (!parsed.success) {
        return Response.json(
          { code: "invalid_request", message: parsed.error.message },
          { status: 400 },
        );
      }
      try {
        await deps.registry.stop(params.runId);
        return Response.json({ stopped: true });
      } catch (err) {
        return errorResponse(err);
      }
    },
    { body: t.Any() },
  );

  app.get("/v1/runs/:runId/outcome", ({ params, headers }) => {
    const denied = authGuard(headers);
    if (denied) return denied;
    if (!deps.registry.hasRun(params.runId)) {
      // Unknown run: 404 so the Adapter never polls a phantom run forever.
      const e = new Error(`no such run: ${params.runId}`) as Error & { code: string };
      e.code = "not_found";
      return errorResponse(e);
    }
    const outcome = deps.registry.getOutcome(params.runId);
    if (!outcome) {
      return Response.json({ status: "running" }, { status: 202 });
    }
    return Response.json(outcome);
  });

  app.get("/v1/runs/:runId/events", ({ params, headers, request }) => {
    const denied = authGuard(headers);
    if (denied) return denied;
    let buf: RunEventBuffer;
    try {
      buf = deps.registry.getEvents(params.runId);
    } catch (err) {
      return errorResponse(err);
    }

    const lastEventIdHeader = headers["last-event-id"];
    const lastEventId = lastEventIdHeader !== undefined ? Number(lastEventIdHeader) : -1;

    // Reject stale replays before the stream opens so the 409 is an HTTP
    // status, not an in-band SSE error event. Both a requested id older than
    // the retained window (events evicted) and one ahead of the buffer (the
    // run never produced it) are unreplayable.
    const oldest = buf.oldestRetainedId();
    const newest = buf.lastId();
    if (
      (oldest !== null && lastEventId >= 0 && lastEventId < oldest) ||
      (newest >= 0 && lastEventId > newest)
    ) {
      return Response.json(
        {
          code: "replay_window_exceeded",
          message: `replay window exceeded: requested ${lastEventId}, retained ${oldest}..${newest}`,
        },
        { status: 409 },
      );
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        // Capture the unsubscribe so abort removes the sink from the buffer's
        // subscriber set (no leak across reconnects).
        const unsubscribe = buf.subscribeAfter(lastEventId, (event) => {
          // Slow-subscriber bound: if the reader falls behind (queue backed
          // up past the threshold), evict this subscriber by throwing - the
          // buffer removes it so the run keeps flowing for others.
          if ((controller.desiredSize ?? 0) < -SLOW_SUBSCRIBER_LIMIT) {
            throw new Error("slow subscriber evicted");
          }
          controller.enqueue(encoder.encode(sseEncode(event.id, event.type, event.data)));
        });
        const cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        // heartbeat
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            cleanup();
          }
        }, 15_000);
        // End the stream when the client disconnects.
        request.signal.addEventListener("abort", cleanup);
        // End the stream when the run settles (buffer closed by the outcome).
        buf.onClose(cleanup);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  return app;
}
