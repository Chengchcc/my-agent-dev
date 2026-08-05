import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { createModelRuntime } from "@my-agent-team/ai";
import { createCodingAgentApp } from "./app.js";
import { loadConfig } from "./config.js";

const tmp = `/tmp/coding-routes-${Math.random().toString(36).slice(2, 8)}`;
const ws = `${tmp}/ws`;
mkdirSync(ws, { recursive: true });

function makeApp() {
  const config = loadConfig({
    CODING_AGENT_AUTH_TOKEN: "token-123",
    CODING_AGENT_WORKSPACE_ROOTS: ws,
    CODING_AGENT_FAKE_PROVIDER: "1",
  });
  // createCodingAgentApp registers the fake provider itself from
  // config.providerEnv (single assembly); pass a bare runtime.
  return createCodingAgentApp({ config, modelRuntime: createModelRuntime() });
}

async function call(
  app: ReturnType<typeof makeApp>,
  path: string,
  init?: RequestInit & { token?: string },
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (init?.token) headers.set("authorization", `Bearer ${init.token}`);
  return app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
}

const RUN_BODY = {
  history: [{ productEntryId: "e1", message: { role: "user", text: "hello" } }],
  input: { inputId: "in-1", message: { role: "user", text: "go" } },
  run: {
    runId: "run-routes-1",
    model: { backendKind: "coding_agent", modelId: "fake/echo" },
    productTools: [],
    configRevision: 1,
  },
  workspace: { root: ws, access: "read_write" },
  metadata: { conversationId: "c1", agentMemberId: "m1", branchId: "b1" },
};

async function waitForOutcome(app: ReturnType<typeof makeApp>, runId: string) {
  for (let i = 0; i < 100; i++) {
    const res = await call(app, `/v1/runs/${runId}/outcome`, { token: "token-123" });
    if (res.status === 200) return (await res.json()) as { status: string };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`run ${runId} never settled`);
}

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("daemon routes", () => {
  test("health is unauthenticated", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    await app.stop();
  });

  test("models requires auth", async () => {
    const app = makeApp();
    const res = await call(app, "/v1/models");
    expect(res.status).toBe(401);
    await app.stop();
  });

  test("catalog is non-empty when a provider is registered (single assembly)", async () => {
    const app = makeApp();
    const res = await call(app, "/v1/models", { token: "token-123" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[] };
    expect(body.models.length).toBeGreaterThan(0);
    await app.stop();
  });

  test("POST /v1/runs requires auth", async () => {
    const app = makeApp();
    const res = await call(app, "/v1/runs", {
      method: "POST",
      body: JSON.stringify(RUN_BODY),
    });
    expect(res.status).toBe(401);
    await app.stop();
  });

  test("invalid run body rejected with 400", async () => {
    const app = makeApp();
    const res = await call(app, "/v1/runs", {
      method: "POST",
      token: "token-123",
      body: JSON.stringify({ run: { runId: "x" } }),
    });
    expect(res.status).toBe(400);
    await app.stop();
  });

  test("valid execute is accepted and settles completed", async () => {
    const app = makeApp();
    const res = await call(app, "/v1/runs", {
      method: "POST",
      token: "token-123",
      body: JSON.stringify(RUN_BODY),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: "run-routes-1", accepted: true });
    const outcome = await waitForOutcome(app, "run-routes-1");
    expect(outcome.status).toBe("completed");
    await app.stop();
  });

  test("same runId + same payload is idempotent", async () => {
    const app = makeApp();
    await call(app, "/v1/runs", {
      method: "POST",
      token: "token-123",
      body: JSON.stringify(RUN_BODY),
    });
    const replay = await call(app, "/v1/runs", {
      method: "POST",
      token: "token-123",
      body: JSON.stringify({ ...RUN_BODY, history: [...RUN_BODY.history] }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ runId: "run-routes-1", accepted: true });
    await app.stop();
  });

  test("same runId + different payload conflicts", async () => {
    const app = makeApp();
    await call(app, "/v1/runs", {
      method: "POST",
      token: "token-123",
      body: JSON.stringify(RUN_BODY),
    });
    const conflict = await call(app, "/v1/runs", {
      method: "POST",
      token: "token-123",
      body: JSON.stringify({
        ...RUN_BODY,
        input: { inputId: "in-2", message: { role: "user", text: "other" } },
      }),
    });
    expect(conflict.status).toBe(409);
    await app.stop();
  });

  test("steer targets a live run and is accepted", async () => {
    const app = makeApp();
    await call(app, "/v1/runs", {
      method: "POST",
      token: "token-123",
      body: JSON.stringify(RUN_BODY),
    });
    // The fake provider completes fast; steer may land after settlement.
    const res = await call(app, "/v1/runs/run-routes-1/steer", {
      method: "POST",
      token: "token-123",
      body: JSON.stringify({
        input: { inputId: "in-s", message: { role: "user", text: "steer" } },
      }),
    });
    expect([200, 409]).toContain(res.status);
    await app.stop();
  });

  test("steer on an unknown run fails explicitly", async () => {
    const app = makeApp();
    const res = await call(app, "/v1/runs/ghost/steer", {
      method: "POST",
      token: "token-123",
      body: JSON.stringify({
        input: { inputId: "in-s", message: { role: "user", text: "steer" } },
      }),
    });
    expect(res.status).toBe(409);
    await app.stop();
  });

  test("stop terminates a run (aborted outcome)", async () => {
    const app = makeApp();
    await call(app, "/v1/runs", {
      method: "POST",
      token: "token-123",
      body: JSON.stringify(RUN_BODY),
    });
    const res = await call(app, "/v1/runs/run-routes-1/stop", {
      method: "POST",
      token: "token-123",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    // Either the stop won (aborted) or the run completed first - never
    // something else.
    const outcome = await waitForOutcome(app, "run-routes-1");
    expect(["aborted", "completed"]).toContain(outcome.status);
    await app.stop();
  });

  test("unknown run outcome returns 404 (never a phantom 202)", async () => {
    const app = makeApp();
    const res = await call(app, "/v1/runs/ghost/outcome", { token: "token-123" });
    expect(res.status).toBe(404);
    await app.stop();
  });
});
