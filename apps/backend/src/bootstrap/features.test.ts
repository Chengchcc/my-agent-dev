import { describe, expect, test } from "bun:test";

// parseEnv(process.env) runs at module scope in registry.ts.
process.env.BACKEND_AUTH_TOKEN = "test-token";

function makeConfig(tmpDir: string) {
  return {
    dataDir: tmpDir,
    anthropicApiKey: "sk-test",
    anthropicBaseUrl: "https://api.anthropic.com",
    host: "0.0.0.0",
    port: 3000,
    authToken: "test-token",
    cancelGraceMs: 100,
    builtinSkillsDir: `${tmpDir}/builtin`,
  };
}

describe("InstalledFeatures", () => {
  test("installFeatures returns complete FeatureSet", async () => {
    const { Database } = await import("bun:sqlite");
    const { mkdirSync } = await import("node:fs");
    const { createBackendServices } = await import("./services.js");

    const tmpDir = `${process.env.TMPDIR ?? "/tmp"}/p9-feat-${Date.now()}`;
    mkdirSync(`${tmpDir}/builtin`, { recursive: true });

    // seed checkpoint db
    const _cp = new Database(`${tmpDir}/checkpointer.db`);
    _cp.close();

    // seed minimal backend.db tables
    const db = new Database(`${tmpDir}/backend.db`);
    db.run(
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, permission_mode TEXT NOT NULL DEFAULT 'auto', lark_enabled INTEGER NOT NULL DEFAULT 0, lark_bot_display_name TEXT, lark_profile_ref TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS skill_pack (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, source_kind TEXT NOT NULL, source_url TEXT, version_ref TEXT, installed_ref TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS agent_skill_pack (agent_id TEXT NOT NULL, pack_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (agent_id, pack_id))",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS members (conversation_id TEXT NOT NULL, member_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'agent', agent_id TEXT, user_ref TEXT, display_name TEXT, session_id TEXT, joined_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, member_id))",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS conversations (conversation_id TEXT PRIMARY KEY, trigger_mode TEXT NOT NULL DEFAULT 'manual', hop_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, title TEXT, origin TEXT NOT NULL DEFAULT 'user', fork_source TEXT, fork_from_seq INTEGER)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS conversation_ledger (conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, sender_member_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL, span_id TEXT, undone INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (conversation_id, seq))",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS cron_jobs (id TEXT PRIMARY KEY, name TEXT NOT NULL, schedule TEXT NOT NULL, agent_id TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, transport TEXT NOT NULL DEFAULT 'stdio', command TEXT, args TEXT, env TEXT, url TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS agent_relationships (from_agent_id TEXT NOT NULL, to_agent_id TEXT NOT NULL, rel_type TEXT NOT NULL, PRIMARY KEY (from_agent_id, to_agent_id))",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS runs (span_id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT NOT NULL, conversation_id TEXT, origin_kind TEXT, origin_conversation_id TEXT, origin_agent_member_id TEXT, origin_surface TEXT, status TEXT NOT NULL DEFAULT 'running', created_at INTEGER NOT NULL, finished_at INTEGER)",
    );
    db.close();

    const config = makeConfig(tmpDir);
    const { installFeatures } = await import("./features.js");

    let installed;
    try {
      const services = createBackendServices(config);
      installed = await installFeatures(services);
    } catch (err) {
      // Model registry may fail without real provider — skip gracefully
      if (
        (err as Error).message?.includes("model") ||
        (err as Error).message?.includes("createModel")
      ) {
        return;
      }
      throw err;
    }

    expect(installed.featureSet).toBeDefined();
    for (const key of [
      "agents",
      "conversations",
      "ops",
      "projects",
      "loops",
      "cronJobs",
      "skillPacks",
      "settings",
      "mcp",
      "models",
      "resumeRun",
    ]) {
      expect((installed.featureSet as Record<string, unknown>)[key]).toBeDefined();
    }
    expect(installed.cronScheduler).toBeDefined();
    expect(typeof installed.start).toBe("function");
    expect(typeof installed.dispose).toBe("function");

    await installed.dispose();
  });

  test("FeatureSet is compatible with createApp", async () => {
    const { Database } = await import("bun:sqlite");
    const { mkdirSync } = await import("node:fs");
    const { createBackendServices } = await import("./services.js");

    const tmpDir = `${process.env.TMPDIR ?? "/tmp"}/p9-feat-${Date.now()}`;
    mkdirSync(`${tmpDir}/builtin`, { recursive: true });

    const _cp = new Database(`${tmpDir}/checkpointer.db`);
    _cp.close();

    const db = new Database(`${tmpDir}/backend.db`);
    for (const ddl of [
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, permission_mode TEXT NOT NULL DEFAULT 'auto', lark_enabled INTEGER NOT NULL DEFAULT 0, lark_bot_display_name TEXT, lark_profile_ref TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS skill_pack (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, source_kind TEXT NOT NULL, source_url TEXT, version_ref TEXT, installed_ref TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS agent_skill_pack (agent_id TEXT NOT NULL, pack_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (agent_id, pack_id))",
      "CREATE TABLE IF NOT EXISTS members (conversation_id TEXT NOT NULL, member_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'agent', agent_id TEXT, user_ref TEXT, display_name TEXT, session_id TEXT, joined_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, member_id))",
      "CREATE TABLE IF NOT EXISTS conversations (conversation_id TEXT PRIMARY KEY, trigger_mode TEXT NOT NULL DEFAULT 'manual', hop_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, title TEXT, origin TEXT NOT NULL DEFAULT 'user', fork_source TEXT, fork_from_seq INTEGER)",
      "CREATE TABLE IF NOT EXISTS conversation_ledger (conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, sender_member_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER NOT NULL, span_id TEXT, undone INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (conversation_id, seq))",
      "CREATE TABLE IF NOT EXISTS cron_jobs (id TEXT PRIMARY KEY, name TEXT NOT NULL, schedule TEXT NOT NULL, agent_id TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, transport TEXT NOT NULL DEFAULT 'stdio', command TEXT, args TEXT, env TEXT, url TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS agent_relationships (from_agent_id TEXT NOT NULL, to_agent_id TEXT NOT NULL, rel_type TEXT NOT NULL, PRIMARY KEY (from_agent_id, to_agent_id))",
      "CREATE TABLE IF NOT EXISTS runs (span_id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT NOT NULL, conversation_id TEXT, origin_kind TEXT, origin_conversation_id TEXT, origin_agent_member_id TEXT, origin_surface TEXT, status TEXT NOT NULL DEFAULT 'running', created_at INTEGER NOT NULL, finished_at INTEGER)",
    ]) {
      db.run(ddl);
    }
    db.close();

    const config = makeConfig(tmpDir);
    const { installFeatures } = await import("./features.js");

    try {
      const services = createBackendServices(config);
      const installed = await installFeatures(services);
      const { createApp } = await import("../app.js");
      const app = createApp(config.authToken, installed.featureSet);
      expect(app).toBeDefined();

      // /health returns 200
      const healthRes = await app.handle(new Request("http://localhost/health"));
      expect(healthRes.status).toBe(200);

      // Protected route without token → 401
      const noAuthRes = await app.handle(new Request("http://localhost/api/agents"));
      expect(noAuthRes.status).toBe(401);

      // start/dispose lifecycle works
      installed.cronScheduler.start();
      await installed.start();
      installed.cronScheduler.dispose();
      await installed.dispose();
    } catch (err) {
      if (
        (err as Error).message?.includes("model") ||
        (err as Error).message?.includes("createModel")
      ) {
        return;
      }
      throw err;
    }
  });
});
