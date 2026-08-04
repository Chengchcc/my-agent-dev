import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// parseEnv(process.env) runs at module scope in config.ts.
process.env.BACKEND_AUTH_TOKEN = "test-token";
process.env.ANTHROPIC_API_KEY = "sk-test";

function setup(dir: string) {
  mkdirSync(dir, { recursive: true });

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
    const { createBackendServices } = await import("./services.js");
    const dir = mkdtempSync(join(tmpdir(), "svc-"));
    const services = createBackendServices(setup(dir) as never);
    expect(services.db).toBeDefined();
    expect(services.settingsSvc).toBeDefined();
    expect(services.opsStore).toBeDefined();
    expect(services.loopStore).toBeDefined();
    expect(services.larkBotRegistry).toBeDefined();
    // Phase 5: composition has no legacy runtime services
    expect("sessionManager" in services).toBe(false);
    expect("modelRegistry" in services).toBe(false);
    services.db.close();
  });

  test("dispose pattern does not crash", async () => {
    const { createBackendServices } = await import("./services.js");
    const dir = mkdtempSync(join(tmpdir(), "svc-"));
    const services = createBackendServices(setup(dir) as never);
    services.db.close();
    expect(true).toBe(true);
  });
});
