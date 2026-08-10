import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

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
  const builtinDir = `${dir}/builtin-skills`;
  mkdirSync(dir, { recursive: true });
  mkdirSync(builtinDir, { recursive: true });
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
    builtinSkillsDir: builtinDir,
  };
}

describe("InstalledFeatures", () => {
  test("installFeatures returns complete FeatureSet", async () => {
    const dir = mkdtempSync(`${tmpdir()}/p9-feat-`);
    const cfg = setup(dir);

    const { createBackendServices } = await import("./services.js");
    const services = createBackendServices(cfg as Parameters<typeof createBackendServices>[0]);

    const { installFeatures } = await import("./features.js");
    const installed = await installFeatures(services);

    expect(installed.featureSet).toBeDefined();
    expect(installed.featureSet.agents).toBeDefined();
    expect(installed.featureSet.conversations).toBeDefined();
    expect(installed.featureSet.ops).toBeDefined();
    expect(installed.featureSet.projects).toBeDefined();
    expect(installed.featureSet.loops).toBeDefined();
    expect(installed.featureSet.cronJobs).toBeDefined();
    expect(installed.featureSet.skillPacks).toBeDefined();
    expect(installed.featureSet.agentRuns).toBeDefined();
    expect(installed.featureSet.settings).toBeDefined();
    expect(installed.featureSet.mcp).toBeDefined();
    expect(installed.featureSet.models).toBeDefined();
    expect(installed.cronScheduler).toBeDefined();
    expect(typeof installed.start).toBe("function");
    expect(typeof installed.dispose).toBe("function");

    await installed.dispose();
    await services.mcpClientManager.disconnectAll();
    services.db.close();
  });

  test("createApp mounts FeatureSet, /health 200, lifecycle works", async () => {
    const dir = mkdtempSync(`${tmpdir()}/p9-feat-`);
    const cfg = setup(dir);

    const { createBackendServices } = await import("./services.js");
    const services = createBackendServices(cfg as Parameters<typeof createBackendServices>[0]);

    const { installFeatures } = await import("./features.js");
    const installed = await installFeatures(services);

    const { createApp } = await import("../app.js");
    const app = createApp(cfg.authToken, installed.featureSet);
    expect(app).toBeDefined();

    const healthRes = await app.handle(new Request("http://localhost/health"));
    expect(healthRes.status).toBe(200);

    await installed.start();
    await installed.dispose();

    await services.mcpClientManager.disconnectAll();
    services.db.close();
  });
});
