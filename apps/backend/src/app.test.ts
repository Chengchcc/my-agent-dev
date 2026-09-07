import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Env MUST be set before the feature-graph modules load: lark-bot registry
// runs parseEnv(process.env) at module scope. Static imports here would
// evaluate that graph before the env lines below (this file sorts before
// bootstrap/features.test.ts, which relies on the same ordering) — hence
// the dynamic imports inside setupApp, same pattern as features.test.ts.
process.env.BACKEND_AUTH_TOKEN = "test-token";
process.env.ANTHROPIC_API_KEY = "sk-test";

const TOKEN = "test-token";

const modelsYml = `providers:
  anthropic:
    api: anthropic-messages
    apiKey: ANTHROPIC_API_KEY
    models:
      - id: claude-sonnet-4-6
        name: claude-sonnet-4-6
        maxTokens: 8192
`;

/** Build a REAL FeatureSet (same harness as bootstrap/features.test.ts):
 *  the auth guard must be exercised against the true route plugins, and the
 *  FeatureSet route-level Elysia generics cannot be faithfully stubbed. */
async function setupApp() {
  const dir = mkdtempSync(`${tmpdir()}/auth-gate-`);
  const builtinDir = `${dir}/builtin-skills`;
  mkdirSync(dir, { recursive: true });
  mkdirSync(builtinDir, { recursive: true });
  writeFileSync(`${dir}/models.yml`, modelsYml);

  const cfg = {
    dataDir: dir,
    workspaceRoot: dir,
    templateDir: `${dir}/templates`,
    host: "127.0.0.1",
    port: 3000,
    authToken: TOKEN,
    cancelGraceMs: 100,
    maxConcurrentRuns: 4,
    builtinSkillsDir: builtinDir,
  };

  // Single-step cast, same boundary as bootstrap/features.test.ts setup():
  // the partial test config is a subset of the BackendServices config.
  const { createBackendServices } = await import("./bootstrap/services.js");
  const services = createBackendServices(cfg as Parameters<typeof createBackendServices>[0]);
  const { installFeatures } = await import("./bootstrap/features.js");
  const installed = await installFeatures(services);
  const { createApp } = await import("./app.js");
  return { app: createApp(TOKEN, installed.featureSet), dir };
}

describe("createApp auth gate", () => {
  test("feature route: 401 without token, 401 with wrong token, 200 with correct token", async () => {
    const { app } = await setupApp();
    const url = "http://localhost/api/agents";

    const noToken = await app.handle(new Request(url));
    expect(noToken.status).toBe(401);

    const wrongToken = await app.handle(new Request(url, { headers: { "x-auth-token": "nope" } }));
    expect(wrongToken.status).toBe(401);

    const good = await app.handle(new Request(url, { headers: { "x-auth-token": TOKEN } }));
    expect(good.status).toBe(200);
  });

  test("/health stays unauthenticated", async () => {
    const { app } = await setupApp();
    const res = await app.handle(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
  });
});
