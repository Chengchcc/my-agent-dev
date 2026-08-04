import { createHash } from "node:crypto";
import type { BackendModelCatalog } from "@my-agent-team/agent-backend";
import {
  closeSessionRequestSchema,
  compactSessionRequestSchema,
  type RunOutcomeResponse,
  resumeSessionRequestSchema,
  sendRunRequestSchema,
  startSessionRequestSchema,
  stopSessionRequestSchema,
} from "@my-agent-team/agent-backend";
import { Elysia, t } from "elysia";
import { bearerToken, verifyToken } from "./auth.js";
import { ReplayWindowExceededError, type RunEventBuffer } from "./event-buffer.js";
import type { CodingSessionSupervisor } from "./session-supervisor.js";

/** Max queued chunks before a slow SSE subscriber is evicted (its stream is
 *  closed; the run keeps flowing for others). Bounds memory per connection. */
const SLOW_SUBSCRIBER_LIMIT = 64;

/** Deterministic session id from an idempotency key (SHA-256, hex, 26 chars -
 *  matches the sessionIdSchema charset). Same key => same session, so start
 *  retries replay instead of conflicting. */
function deriveSessionId(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 26);
}
export interface RouteDeps {
  supervisor: CodingSessionSupervisor;
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
    "/v1/sessions/start",
    async ({ body, headers }) => {
      const denied = authGuard(headers);
      if (denied) return denied;
      const parsed = startSessionRequestSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json(
          { code: "invalid_request", message: parsed.error.message },
          { status: 400 },
        );
      }
      try {
        const result = await deps.supervisor.startSession({
          idempotencyKey: parsed.data.idempotencyKey,
          // Stable derivation from the idempotency key: a retry of the same
          // start request maps to the SAME session, so the supervisor's
          // idempotency replay returns the original result instead of a
          // payload-conflict on a freshly randomized ID.
          backendSessionId: deriveSessionId(parsed.data.idempotencyKey),
          history: parsed.data.history as never,
          input: parsed.data.input as never,
          run: parsed.data.run as never,
          workspace: parsed.data.workspace,
          metadata: parsed.data.metadata,
        });
        return Response.json(result);
      } catch (err) {
        return errorResponse(err);
      }
    },
    { body: t.Any() },
  );
  app.post(
    "/v1/sessions/:backendSessionId/resume",
    async ({ params, body, headers }) => {
      const denied = authGuard(headers);
      if (denied) return denied;
      const parsed = resumeSessionRequestSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json(
          { code: "invalid_request", message: parsed.error.message },
          { status: 400 },
        );
      }
      try {
        const result = await deps.supervisor.resumeSession({
          idempotencyKey: parsed.data.idempotencyKey,
          backendSessionId: params.backendSessionId,
          history: parsed.data.history as never,
          input: parsed.data.input as never,
          run: parsed.data.run as never,
          workspace: parsed.data.workspace,
          metadata: parsed.data.metadata,
        });
        return Response.json(result);
      } catch (err) {
        return errorResponse(err);
      }
    },
    { body: t.Any() },
  );

  app.post(
    "/v1/sessions/:backendSessionId/send",
    async ({ params, body, headers }) => {
      const denied = authGuard(headers);
      if (denied) return denied;
      const parsed = sendRunRequestSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json(
          { code: "invalid_request", message: parsed.error.message },
          { status: 400 },
        );
      }
      try {
        const result = await deps.supervisor.send({
          idempotencyKey: parsed.data.idempotencyKey,
          commandId: parsed.data.commandId,
          backendSessionId: params.backendSessionId,
          runId: parsed.data.run.runId,
          mode: parsed.data.mode,
          history: parsed.data.history as never,
          input: parsed.data.input as never,
          run: parsed.data.run as never,
          metadata: parsed.data.metadata,
        });
        return Response.json(result);
      } catch (err) {
        return errorResponse(err);
      }
    },
    { body: t.Any() },
  );

  app.post(
    "/v1/sessions/:backendSessionId/stop",
    async ({ params, body, headers }) => {
      const denied = authGuard(headers);
      if (denied) return denied;
      const parsed = stopSessionRequestSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json(
          { code: "invalid_request", message: parsed.error.message },
          { status: 400 },
        );
      }
      try {
        const result = await deps.supervisor.stop({
          idempotencyKey: parsed.data.idempotencyKey,
          commandId: parsed.data.commandId,
          backendSessionId: params.backendSessionId,
          runId: parsed.data.runId,
        });
        return Response.json(result);
      } catch (err) {
        return errorResponse(err);
      }
    },
    { body: t.Any() },
  );

  app.post(
    "/v1/sessions/:backendSessionId/compact",
    async ({ params, body, headers }) => {
      const denied = authGuard(headers);
      if (denied) return denied;
      const parsed = compactSessionRequestSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json(
          { code: "invalid_request", message: parsed.error.message },
          { status: 400 },
        );
      }
      try {
        const result = await deps.supervisor.compact({
          idempotencyKey: parsed.data.idempotencyKey,
          commandId: parsed.data.commandId,
          backendSessionId: params.backendSessionId,
          runId: parsed.data.runId,
        });
        return Response.json(result);
      } catch (err) {
        return errorResponse(err);
      }
    },
    { body: t.Any() },
  );

  app.delete("/v1/sessions/:backendSessionId", async ({ body, params, headers }) => {
    const denied = authGuard(headers);
    if (denied) return denied;
    // Accept a caller-supplied idempotency key + deleteData via the request
    // body (DELETE bodies are optional; default to a stable per-session key).
    const parsed = closeSessionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return Response.json(
        { code: "invalid_request", message: parsed.error.message },
        { status: 400 },
      );
    }
    try {
      const result = await deps.supervisor.close({
        idempotencyKey: parsed.data.idempotencyKey,
        commandId: parsed.data.commandId,
        backendSessionId: params.backendSessionId,
        deleteData: parsed.data.deleteData ?? false,
      });
      return Response.json(result);
    } catch (err) {
      return errorResponse(err);
    }
  });

  app.get("/v1/runs/:runId/outcome", ({ params, headers }) => {
    const denied = authGuard(headers);
    if (denied) return denied;
    if (!deps.supervisor.hasRun(params.runId)) {
      // Unknown run: 404 so the Adapter never polls a phantom run forever.
      const e = new Error(`no such run: ${params.runId}`) as Error & { code: string };
      e.code = "not_found";
      return errorResponse(e);
    }
    const outcome = deps.supervisor.getOutcome(params.runId) as RunOutcomeResponse | null;
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
      buf = deps.supervisor.getEvents(params.runId);
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
