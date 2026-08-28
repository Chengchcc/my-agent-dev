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
    expect(installed.featureSet.skillPacks).toBeDefined();
    expect(installed.featureSet.agentRuns).toBeDefined();
    expect(installed.featureSet.settings).toBeDefined();
    expect(installed.featureSet.mcp).toBeDefined();
    expect(installed.featureSet.models).toBeDefined();
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

test("fresh boot: default agent carries a real model + the onCreate chain ran", async () => {
  const dir = mkdtempSync(`${tmpdir()}/p9-fresh-`);
  // The oma child's runtime catalog resolves models.yml via
  // OMA_HOME (same env the real deployment sets).
  process.env.OMA_HOME = dir;
  const cfg = setup(dir);

  const { createBackendServices } = await import("./services.js");
  const services = createBackendServices(cfg as Parameters<typeof createBackendServices>[0]);

  const { installFeatures } = await import("./features.js");
  const installed = await installFeatures(services);
  await installed.start();

  const db = services.db;
  const agentRow = db.query("SELECT config FROM agents WHERE id = 'default'").get() as {
    config: string;
  } | null;
  expect(agentRow).not.toBeNull();
  const config = JSON.parse(agentRow!.config) as {
    runtime_config: { runtime: string; model_id: string };
  };
  // The seed derives from the live catalog, never the placeholder.
  expect(config.runtime_config.runtime).toBe("oma");
  expect(config.runtime_config.model_id).not.toBe("unconfigured/none");
  expect(config.runtime_config.model_id).toContain("/");

  // A2 chain: the builtin skill pack is assigned on create.
  const packRows = db
    .query(
      "SELECT ap.pack_id FROM agent_skill_pack ap JOIN skill_pack p ON p.id = ap.pack_id WHERE ap.agent_id = 'default'",
    )
    .all() as Array<{ pack_id: string }>;
  expect(packRows.map((r) => r.pack_id)).toContain("builtin");

  // The workspace reconcile materialized the skills links (.mcp.json is
  // written only when the agent has MCP servers - this bare config has
  // none; the link proves the onCreate reconcile ran).
  const workspace = `${dir}/agents/default`;
  const { existsSync } = await import("node:fs");
  expect(existsSync(`${workspace}/.oma/skills`)).toBe(true);

  await installed.dispose();
  await services.mcpClientManager.disconnectAll();
  services.db.close();
});
