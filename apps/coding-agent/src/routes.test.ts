import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createModelRuntime, type ModelRuntime } from "@my-agent-team/ai";
import { createCodingAgentApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createCodingSessionSupervisor } from "./session-supervisor.js";

const tmp = `/tmp/coding-routes-${Math.random().toString(36).slice(2, 8)}`;
const ws = `${tmp}/ws`;
mkdirSync(ws, { recursive: true });

function makeApp() {
  const config = loadConfig({
    CODING_AGENT_AUTH_TOKEN: "token-123",
    CODING_AGENT_DATA_DIR: tmp,
    CODING_AGENT_WORKSPACE_ROOTS: ws,
  });
  const modelRuntime: ModelRuntime = createModelRuntime();
  // Supervisor with a stub worker entry that never spawns (routes test only
  // exercises auth + validation paths that fail before worker spawn).
  const supervisor = createCodingSessionSupervisor({
    workerEntry: "/nonexistent/worker.ts",
    cwd: tmp,
    sessionsDir: `${tmp}/sessions`,
    authEnv: {},
    eventBufferSize: 10,
    workerStopGraceMs: 100,
    acceptTimeoutMs: 5000,
    idleTimeoutMs: 60_000,
    workspaceRoots: [ws],
  });
  return createCodingAgentApp({ config, modelRuntime, supervisor });
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

describe("daemon routes", () => {
  test("health is unauthenticated", async () => {
    const app = makeApp();
    const res = await call(app, "/health");
    expect(res.status).toBe(200);
  });

  test("models requires auth", async () => {
    const app = makeApp();
    const denied = await call(app, "/v1/models");
    expect(denied.status).toBe(401);
    const ok = await call(app, "/v1/models", { token: "token-123" });
    expect(ok.status).toBe(200);
  });

  test("respond endpoint does not exist", async () => {
    const app = makeApp();
    const res = await call(app, "/v1/sessions/x/respond", { method: "POST", token: "token-123" });
    expect(res.status).toBe(404);
  });

  test("steer route does not exist", async () => {
    const app = makeApp();
    const res = await call(app, "/v1/sessions/x/steer", { method: "POST", token: "token-123" });
    expect(res.status).toBe(404);
  });

  test("invalid start body rejected with 400", async () => {
    const app = makeApp();
    const res = await call(app, "/v1/sessions/start", {
      method: "POST",
      token: "token-123",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("missing auth on send rejected", async () => {
    const app = makeApp();
    const res = await call(app, "/v1/sessions/x/send", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  test("unknown session returns not_found", async () => {
    const app = makeApp();
    const res = await call(app, "/v1/runs/nosuch/outcome", { token: "token-123" });
    expect(res.status).toBe(202); // running (no outcome yet)
  });
});
