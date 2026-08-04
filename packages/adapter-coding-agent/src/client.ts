import type {
  CompactSessionRequest,
  ModelCatalogResponse,
  ResumeSessionRequest,
  RunEventEnvelope,
  RunOutcomeResponse,
  SendRunRequest,
  SessionResponse,
  StartSessionRequest,
  TransportError,
} from "./transport.js";
import {
  modelCatalogResponseSchema,
  runEventEnvelopeSchema,
  runOutcomeResponseSchema,
  sessionResponseSchema,
  transportErrorSchema,
} from "./transport.js";

/** Authenticated HTTP/SSE transport client for the Coding Agent daemon.
 *  No automatic mutation retry: idempotency replay is the caller's choice. */

export interface CodingAgentClientOptions {
  baseUrl: string;
  authToken: string;
  fetchImpl?: typeof fetch;
}

export class CodingAgentClient {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CodingAgentClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.authToken = opts.authToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.authToken}`, "Content-Type": "application/json" };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { code: "internal", message: raw.slice(0, 200) };
      }
      const err = transportErrorSchema.safeParse(parsed);
      throw new (await import("./transport.js")).TransportError(
        err.success ? err.data.code : "internal",
        err.success ? err.data.message : String(parsed),
      );
    }
    return (await res.json()) as T;
  }

  async startSession(input: StartSessionRequest): Promise<SessionResponse> {
    return sessionResponseSchema.parse(await this.request("POST", "/v1/sessions/start", input));
  }

  async resumeSession(
    backendSessionId: string,
    input: ResumeSessionRequest,
  ): Promise<SessionResponse> {
    return sessionResponseSchema.parse(
      await this.request("POST", `/v1/sessions/${backendSessionId}/resume`, input),
    );
  }

  async sendRun(backendSessionId: string, input: SendRunRequest): Promise<{ accepted: boolean }> {
    return (await this.request("POST", `/v1/sessions/${backendSessionId}/send`, input)) as {
      accepted: boolean;
    };
  }

  async stopSession(backendSessionId: string, runId?: string): Promise<{ stopped: boolean }> {
    return (await this.request("POST", `/v1/sessions/${backendSessionId}/stop`, {
      // Stable idempotency: keyed by the active run when known.
      idempotencyKey: runId ? `stop-${runId}` : `stop-${backendSessionId}`,
      commandId: runId ? `stop-${runId}` : `stop-${backendSessionId}`,
      runId,
    })) as { stopped: boolean };
  }

  async closeSession(backendSessionId: string, deleteData = false): Promise<{ closed: boolean }> {
    return (await this.request("DELETE", `/v1/sessions/${backendSessionId}`, {
      idempotencyKey: `close-${backendSessionId}`,
      commandId: `close-${backendSessionId}`,
      deleteData,
    })) as { closed: boolean };
  }

  async compactSession(
    backendSessionId: string,
    input: CompactSessionRequest,
  ): Promise<{ compacted: boolean }> {
    return (await this.request("POST", `/v1/sessions/${backendSessionId}/compact`, input)) as {
      compacted: boolean;
    };
  }

  async getOutcome(runId: string): Promise<RunOutcomeResponse | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/runs/${runId}/outcome`, {
      method: "GET",
      headers: this.headers(),
    });
    if (res.status === 202) return null; // still running
    if (!res.ok) {
      const { TransportError } = await import("./transport.js");
      throw new TransportError(
        res.status === 404 ? "not_found" : "internal",
        `outcome fetch failed: ${res.status} for ${runId}`,
      );
    }
    return runOutcomeResponseSchema.parse(await res.json());
  }

  async getModels(): Promise<ModelCatalogResponse> {
    return modelCatalogResponseSchema.parse(await this.request("GET", "/v1/models"));
  }

  /** Incrementally parse SSE events. Reconnect by passing the last delivered
   *  event id; heartbeat comments are ignored. */
  async *streamEvents(
    runId: string,
    lastEventId?: number,
    signal?: AbortSignal,
  ): AsyncIterable<RunEventEnvelope> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/runs/${runId}/events`, {
      method: "GET",
      headers: {
        ...this.headers(),
        ...(lastEventId !== undefined ? { "Last-Event-ID": String(lastEventId) } : {}),
      },
      signal,
    });
    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => "");
      const { TransportError, transportErrorSchema } = await import("./transport.js");
      const parsed = transportErrorSchema.safeParse(raw ? JSON.parse(raw) : null);
      if (parsed.success) {
        throw new TransportError(parsed.data.code, parsed.data.message);
      }
      throw new TransportError("internal", `SSE failed: ${res.status} ${raw.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let currentId: number | undefined;
    let currentEvent: string | undefined;
    let dataLines: string[] = [];

    const flush = (): RunEventEnvelope | null => {
      if (dataLines.length === 0) return null;
      const envelope = runEventEnvelopeSchema.parse({
        id: currentId ?? -1,
        type: currentEvent ?? "event",
        data: JSON.parse(dataLines.join("\n")),
      });
      dataLines = [];
      return envelope;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (line === "") {
            const flushed = flush();
            if (flushed) yield flushed;
            currentId = undefined;
            currentEvent = undefined;
            continue;
          }
          if (line.startsWith(":")) continue; // heartbeat comment
          if (line.startsWith("id: ")) {
            const flushed = flush();
            if (flushed) yield flushed;
            currentId = Number(line.slice(4));
          } else if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6));
          }
        }
      }
      const flushed = flush();
      if (flushed) yield flushed;
    } finally {
      reader.releaseLock();
    }
  }
}

export type { TransportError };
