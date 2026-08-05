import type {
  CreateRunRequest,
  ModelCatalogResponse,
  RunEventEnvelope,
  RunOutcomeResponse,
  TransportError,
} from "./transport.js";
import {
  createRunResponseSchema,
  modelCatalogResponseSchema,
  parseTransportError,
  runEventEnvelopeSchema,
  runOutcomeResponseSchema,
} from "./transport.js";

/** Authenticated HTTP/SSE transport client for the Coding Agent daemon.
 *  Run-centric: POST /v1/runs creates/accepts a Run, steer/stop target the
 *  runId, outcome/events poll/stream by runId. No automatic mutation retry:
 *  idempotency replay is the caller's choice. */

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
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new Error(`coding-agent request failed: ${String(err)}`, { cause: err });
    }
    if (!res.ok) {
      let raw: unknown = null;
      try {
        raw = await res.json();
      } catch {
        /* non-JSON error body */
      }
      throw parseTransportError(raw);
    }
    return (await res.json()) as T;
  }

  /** Accept a new Run. Idempotent for same runId + same payload; same runId +
   *  different payload conflicts (409). */
  async execute(input: CreateRunRequest): Promise<{ runId: string; accepted: boolean }> {
    return createRunResponseSchema.parse(await this.request("POST", "/v1/runs", input));
  }

  /** Inject a steer input into the live Run. Fails (409) when the run is not
   *  live - never silently converted into a normal input. */
  async steer(runId: string, input: CreateRunRequest["input"]): Promise<void> {
    await this.request("POST", `/v1/runs/${runId}/steer`, { input });
  }

  /** Request cancellation of a Run. Idempotent. */
  async stop(runId: string): Promise<void> {
    await this.request("POST", `/v1/runs/${runId}/stop`, {});
  }

  async getOutcome(runId: string): Promise<RunOutcomeResponse | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/runs/${runId}/outcome`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.authToken}` },
    });
    if (res.status === 202) return null;
    if (!res.ok) {
      let raw: unknown = null;
      try {
        raw = await res.json();
      } catch {
        /* non-JSON error body */
      }
      throw parseTransportError(raw);
    }
    return runOutcomeResponseSchema.parse(await res.json());
  }

  async getModels(): Promise<ModelCatalogResponse> {
    return modelCatalogResponseSchema.parse(await this.request("GET", "/v1/models"));
  }

  /** Incrementally parse SSE events. Reconnect by passing the last delivered
   *  event id; heartbeat comments are ignored. The stream ends when the
   *  daemon closes the run's buffer (outcome settled); callers decide whether
   *  to reconnect. */
  async *streamEvents(
    runId: string,
    lastEventId?: number,
    signal?: AbortSignal,
  ): AsyncIterable<RunEventEnvelope> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.authToken}`,
      Accept: "text/event-stream",
    };
    if (lastEventId !== undefined) headers["Last-Event-ID"] = String(lastEventId);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/runs/${runId}/events`, {
        method: "GET",
        headers,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      throw new Error(`coding-agent SSE failed: ${String(err)}`, { cause: err });
    }
    if (!res.ok) {
      let raw: unknown = null;
      try {
        raw = await res.json();
      } catch {
        /* non-JSON error body */
      }
      throw parseTransportError(raw);
    }
    if (!res.body) throw new Error("coding-agent SSE: empty body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const idx = buffer.indexOf("\n\n");
          if (idx < 0) break;
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = parseSseFrame(frame);
          if (!event) continue;
          yield event;
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      throw err;
    } finally {
      reader.releaseLock();
    }
  }
}

function parseSseFrame(frame: string): RunEventEnvelope | null {
  let id: number | null = null;
  let eventType = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trimStart();
    if (field === "id") id = Number(value);
    else if (field === "event") eventType = value;
    else if (field === "data") dataLines.push(value);
  }
  if (id === null || dataLines.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
  return runEventEnvelopeSchema.parse({ id, type: eventType, data });
}

export type { TransportError };
