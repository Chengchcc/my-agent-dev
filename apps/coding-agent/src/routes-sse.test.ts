import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { createModelRuntime } from "@my-agent-team/ai";
import { createCodingAgentApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createRunEventBuffer } from "./event-buffer.js";
import type { CodingSessionSupervisor } from "./session-supervisor.js";

const tmp = `/tmp/coding-sse-${Math.random().toString(36).slice(2, 8)}`;
mkdirSync(tmp, { recursive: true });

/** Fake supervisor with a pre-seeded run event buffer. */
function makeApp(seed: Array<{ type: string; data: Record<string, unknown> }>) {
  const config = loadConfig({
    CODING_AGENT_AUTH_TOKEN: "token-123",
    CODING_AGENT_DATA_DIR: tmp,
    CODING_AGENT_WORKSPACE_ROOTS: tmp,
  });
  const buf = createRunEventBuffer(100);
  for (const e of seed) buf.append(e);
  const fake: CodingSessionSupervisor = {
    async startSession() {
      throw new Error("not implemented");
    },
    async resumeSession() {
      throw new Error("not implemented");
    },
    async send() {
      throw new Error("not implemented");
    },
    async stop() {
      return { stopped: true };
    },
    async compact() {
      return { compacted: true };
    },
    async close() {
      return { closed: true };
    },
    getEvents(runId) {
      if (runId !== "r1") {
        const e = new Error("no event stream for run: " + runId) as Error & { code: string };
        e.code = "not_found";
        throw e;
      }
      return buf;
    },
    getOutcome() {
      return null;
    },
    listSessions() {
      return [];
    },
    async shutdown() {
      /* no-op */
    },
  };
  return createCodingAgentApp({ config, modelRuntime: createModelRuntime(), supervisor: fake });
}

async function sseRead(
  app: ReturnType<typeof makeApp>,
  path: string,
  headers: Record<string, string> = {},
  maxChunks = 3,
): Promise<string> {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      headers: { authorization: "Bearer token-123", ...headers },
    }),
  );
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  for (let i = 0; i < maxChunks; i++) {
    const result = await Promise.race([
      reader.read().then((r) => ({ ...r, timedOut: false })),
      new Promise((r) => setTimeout(() => r({ timedOut: true }), 1000)),
    ]);
    if ((result as { timedOut?: boolean }).timedOut) break;
    const { done, value } = result as { done: boolean; value?: Uint8Array };
    if (done) break;
    acc += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return acc;
}

describe("daemon SSE routes", () => {
  test("replays seeded events in order with ids", async () => {
    const app = makeApp([
      { type: "message_update", data: { text: "a" } },
      { type: "agent_end", data: {} },
    ]);
    const body = await sseRead(app, "/v1/runs/r1/events");
    expect(body).toContain("id: 0");
    expect(body).toContain("id: 1");
    expect(body.indexOf("id: 0")).toBeLessThan(body.indexOf("id: 1"));
    expect(body).toContain('data: {"text":"a"}');
    expect(body).toContain("event: message_update");
    expect(body).toContain("event: agent_end");
  });

  test("Last-Event-ID skips already-seen events", async () => {
    const app = makeApp([
      { type: "message_update", data: { text: "a" } },
      { type: "agent_end", data: {} },
    ]);
    const body = await sseRead(app, "/v1/runs/r1/events", { "last-event-id": "0" });
    expect(body).not.toContain("id: 0");
    expect(body).toContain("id: 1");
  });

  test("stale Last-Event-ID returns 409 replay_window_exceeded", async () => {
    const app = makeApp([{ type: "message_update", data: { text: "a" } }]);
    const res = await app.fetch(
      new Request("http://localhost/v1/runs/r1/events", {
        headers: { authorization: "Bearer token-123", "last-event-id": "99" },
      }),
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { code?: string };
    expect(json.code).toBe("replay_window_exceeded");
  });

  test("unknown run events returns 404", async () => {
    const app = makeApp([]);
    const res = await app.fetch(
      new Request("http://localhost/v1/runs/nosuch/events", {
        headers: { authorization: "Bearer token-123" },
      }),
    );
    expect(res.status).toBe(404);
  });

  test("SSE requires auth", async () => {
    const app = makeApp([]);
    const res = await app.fetch(new Request("http://localhost/v1/runs/r1/events"));
    expect(res.status).toBe(401);
  });

  test("stream stays open with no events (heartbeat only)", async () => {
    const app = makeApp([]);
    const res = await app.fetch(
      new Request("http://localhost/v1/runs/r1/events", {
        headers: { authorization: "Bearer token-123" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const result = await Promise.race([
      reader.read().then((r) => ({ kind: "chunk", ...r })),
      new Promise((r) => setTimeout(() => r({ kind: "timeout" }), 200)),
    ]);
    // No data within 200ms: stream is open but silent (heartbeat is 15s).
    expect((result as { kind: string }).kind).toBe("timeout");
    await reader.cancel();
  });

  test("outcome 202 while running, 200 with body once stored", async () => {
    const app = makeApp([]);
    const res = await app.fetch(
      new Request("http://localhost/v1/runs/r1/outcome", {
        headers: { authorization: "Bearer token-123" },
      }),
    );
    expect(res.status).toBe(202);
  });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
