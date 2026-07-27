import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// parseEnv(process.env) runs at module scope in registry.ts.
process.env.BACKEND_AUTH_TOKEN = "test-token";
process.env.ANTHROPIC_API_KEY = "sk-test";

const modelsYml = `providers:
  anthropic:
    api: anthropic-messages
    apiKey: ANTHROPIC_API_KEY
    models:
      - id: claude-sonnet-4-6
        name: claude-sonnet-4-6
        maxTokens: 8192
`;

function setup(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/models.yml`, modelsYml);

  return {
    dataDir: dir,
    workspaceRoot: dir,
    templateDir: `${dir}/templates`,
    anthropicApiKey: "sk-test",
    anthropicBaseUrl: "https://api.anthropic.com",
    host: "0.0.0.0",
    port: 3000,
    authToken: "test-token",
    cancelGraceMs: 100,
    maxConcurrentRuns: 4,
    shutdownTimeoutMs: 5000,
    reaperIntervalMs: 30000,
    stepStallTimeoutMs: 300000,
    builtinSkillsDir: dir,
  };
}

describe("BackendServices", () => {
  test("creates shared services with minimal config", async () => {
    const dir = mkdtempSync(`${tmpdir()}/p9-svc-`);
    const cfg = setup(dir);

    const { createBackendServices } = await import("./services.js");
    const { Database } = await import("bun:sqlite");

    const _cp = new Database(`${dir}/checkpointer.db`);
    _cp.close();

    const services = createBackendServices(cfg as Parameters<typeof createBackendServices>[0]);
    expect(services.db).toBeInstanceOf(Database);
    expect(services.settingsSvc).toBeDefined();
    expect(services.modelRegistry).toBeDefined();
    expect(services.sessionManager).toBeDefined();
    expect(services.supervisor).toBeDefined();
    await services.supervisor.dispose();
    await services.mcpClientManager.disconnectAll();
    services.db.close();
  });

  test("SessionManager creates Agent with echo model", async () => {
    const dir = mkdtempSync(`${tmpdir()}/p9-svc-`);
    const cfg = setup(dir);

    const { createBackendServices } = await import("./services.js");
    const { Database } = await import("bun:sqlite");
    const _cp = new Database(`${dir}/checkpointer.db`);
    _cp.close();

    const services = createBackendServices(cfg as Parameters<typeof createBackendServices>[0]);

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
    await services.supervisor.dispose();
    await services.mcpClientManager.disconnectAll();
    services.db.close();
  });

  test("dispose pattern does not crash", async () => {
    const dir = mkdtempSync(`${tmpdir()}/p9-svc-`);
    const cfg = setup(dir);

    const { createBackendServices } = await import("./services.js");
    const { Database } = await import("bun:sqlite");
    const _cp = new Database(`${dir}/checkpointer.db`);
    _cp.close();

    const services = createBackendServices(cfg as Parameters<typeof createBackendServices>[0]);
    await services.supervisor.dispose();
    await services.mcpClientManager.disconnectAll();
    services.db.close();
    expect(true).toBe(true);
  });
});
