import { afterAll, beforeEach, describe, expect, test } from "bun:test";

// parseEnv(process.env) runs at module scope in registry.ts.
// Must set env BEFORE any static import that reaches it.
process.env.BACKEND_AUTH_TOKEN = "test-token";

describe("BackendServices", () => {
  test("creates shared services with minimal config", async () => {
    const { createBackendServices } = await import("./services.js");
    const { Database } = await import("bun:sqlite");

    const tmpDir = `${process.env.TMPDIR ?? "/tmp"}/p9-svc-${Date.now()}`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(tmpDir, { recursive: true });

    // seed checkpoint db
    const _cp = new Database(`${tmpDir}/checkpointer.db`);
    _cp.close();

    const services = createBackendServices({
      dataDir: tmpDir,
      anthropicApiKey: "sk-test",
      anthropicBaseUrl: "https://api.anthropic.com",
      host: "0.0.0.0",
      port: 3000,
      authToken: "test-token",
      cancelGraceMs: 100,
      builtinSkillsDir: tmpDir,
    } as Parameters<typeof createBackendServices>[0]);

    expect(services.db).toBeInstanceOf(Database);
    expect(services.settingsSvc).toBeDefined();
    expect(services.modelRegistry).toBeDefined();
    expect(services.anthropicAuth.apiKey).toBe("sk-test");
    expect(services.sessionManager).toBeDefined();
    expect(services.supervisor).toBeDefined();
    expect(services.opsStore).toBeDefined();
    services.db.close();
  });

  test("SessionManager and Supervisor are wired mutually", async () => {
    const { createBackendServices } = await import("./services.js");
    const { Database } = await import("bun:sqlite");

    const tmpDir = `${process.env.TMPDIR ?? "/tmp"}/p9-svc-${Date.now()}`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(tmpDir, { recursive: true });
    const _cp = new Database(`${tmpDir}/checkpointer.db`);
    _cp.close();

    const services = createBackendServices({
      dataDir: tmpDir,
      anthropicApiKey: "sk-test",
      anthropicBaseUrl: "https://api.anthropic.com",
      host: "0.0.0.0",
      port: 3000,
      authToken: "test-token",
      cancelGraceMs: 100,
      builtinSkillsDir: tmpDir,
    } as Parameters<typeof createBackendServices>[0]);

    const agent = services.sessionManager.create({
      model: {
        stream: async function* () {
          yield { type: "text_delta", text: "ok" };
        },
      } as never,
    });
    expect(agent).toBeDefined();
    expect(agent.sessionId).toBeDefined();
    agent.dispose();
    services.sessionManager.dispose(agent.sessionId!);
    services.db.close();
  });

  test("dispose pattern does not crash", async () => {
    const { createBackendServices } = await import("./services.js");
    const { Database } = await import("bun:sqlite");

    const tmpDir = `${process.env.TMPDIR ?? "/tmp"}/p9-svc-${Date.now()}`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(tmpDir, { recursive: true });
    const _cp = new Database(`${tmpDir}/checkpointer.db`);
    _cp.close();

    const services = createBackendServices({
      dataDir: tmpDir,
      anthropicApiKey: "sk-test",
      anthropicBaseUrl: "https://api.anthropic.com",
      host: "0.0.0.0",
      port: 3000,
      authToken: "test-token",
      cancelGraceMs: 100,
      builtinSkillsDir: tmpDir,
    } as Parameters<typeof createBackendServices>[0]);

    services.supervisor.cancelAll();
    services.mcpClientManager.disconnectAll();
    services.db.close();
    expect(true).toBe(true);
  });
});
