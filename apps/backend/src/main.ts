import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createMcpClientManager } from "@my-agent-team/adapter-mcp";
import { SqliteSessionManager } from "@my-agent-team/agent";
import {
  autoSummarize,
  pipeContextManagers,
  sqliteCheckpointer,
  toolResultTruncator,
} from "@my-agent-team/framework";
import {
  createRuntimeTracer,
  resolveObservabilityConfig,
} from "@my-agent-team/runtime-observability";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createAgentSvc } from "./features/agent/agent-compose.js";
import { createAgentIdentityStore } from "./features/agent/agent-identity.js";
import { agentRoutes } from "./features/agent/index.js";
import { createRelationshipService } from "./features/agent/relationship-service.js";
import { createConversationFeature } from "./features/conversation/conversation-compose.js";
import { conversationRoutes } from "./features/conversation/index.js";
import { onRunComplete } from "./features/conversation/run-accumulator.js";
import {
  createCronJobService,
  createCronScheduler,
  cronJobRoutes,
  sqliteCronJobAdapter,
} from "./features/cron/index.js";
import { CliSetupProvisioner, LarkSetupManager } from "./features/lark-bot/index.js";
import { createLarkBotRegistry } from "./features/lark-bot/lark-bot-registry-factory.js";
import { loopRoutes } from "./features/loop/http.js";
import { createLoopStateStore } from "./features/loop/loop-state-store.js";
import { createMcpService, mcpRoutes, sqliteMcpServerAdapter } from "./features/mcp/index.js";
import { modelRoutes } from "./features/models/index.js";
import {
  createProjectService,
  projectRoutes,
  sqliteProjectAdapter,
} from "./features/project/index.js";
import {
  createRuntimeOpsService,
  opsRoutes,
  RuntimeOpsStore,
} from "./features/runtime-ops/index.js";
import {
  createSettingsService,
  settingsRoutes,
  sqliteSettingsAdapter,
} from "./features/settings/index.js";
import {
  createSkillPackService as createSkillPackServiceFn,
  runInstall,
  runSync,
  seedSkillPacks,
  setSkillPackPort,
  skillPackRoutes,
  sqliteSkillPackAdapter,
} from "./features/skill-pack/index.js";
import {
  createDefaultModelRegistry,
  createModel,
  defaultContextManager,
  defaultPlugins,
  defaultTools,
  resolveModel,
} from "./features/span/agent-helpers.js";
import { resumeRoutes } from "./features/span/http.js";
import { SpanSupervisor } from "./features/span/supervisor.js";
import * as backendSchema from "./infra/db/schema.js";
import { ulid } from "./infra/ids.js";
import { openDb } from "./infra/sqlite/db.js";
import { createServer } from "./server.js";

// ─── Bootstrap ─────────────────────────────────────────────────

const config = loadConfig();
const db = openDb(`${config.dataDir}/backend.db`);
const loopStore = createLoopStateStore(db);
// Single database — all backend-package-owned tables live in one SQLite file.

// Settings service (KV store - runtime-tunable config) - created early
// so all features can read runtime parameters via settingsSvc.get().
const settingsSvc = createSettingsService({
  port: sqliteSettingsAdapter(db),
  config,
});

const modelRegistry = createDefaultModelRegistry(config);
const anthropicAuth = { apiKey: config.anthropicApiKey, baseUrl: config.anthropicBaseUrl };
const mcpClientManager = createMcpClientManager();

const obsConfig = resolveObservabilityConfig({ serviceName: "backend" });
const tracer = createRuntimeTracer(obsConfig);
const opsStore = new RuntimeOpsStore(db);

// Runner daemon removed — AgentSession runs in-process. Supervisor manages
// run/attempt rows without transport (NOOP_TRANSPORT is the internal default).

// Shared SessionManager — all execution paths (conversation, cron, orchestrator)
// and the resume route share the same instance so sessions are visible across
// the process. Replaces the per-run session-registry.ts.
const supervisor = new SpanSupervisor({
  config,
  opsStore,
  tracer,
  db: db,
  onReap: (_runId, sessionId) => sessionManager.dispose(sessionId),
});

const sessionManager = new SqliteSessionManager({
  checkpointerPath: join(config.dataDir, "checkpointer.db"),
  startSpan: (sid, sid2, opts) => supervisor.startSpan(sid, sid2, opts),
});

// ─── Skill Pack Management (before agentSvc — onCreate depends on it) ──

const skillPackPort = sqliteSkillPackAdapter(db);
setSkillPackPort(skillPackPort);

await seedSkillPacks({
  port: skillPackPort,
  dataDir: config.dataDir,
  builtinSkillsDir: config.builtinSkillsDir,
});
const skillPackSvc = createSkillPackServiceFn({
  port: skillPackPort,
  idGen: ulid,
  triggerInstall: (packId, ctx) => {
    void runInstall(
      { packId, sourceKind: ctx.sourceKind, sourceUrl: ctx.sourceUrl, versionRef: ctx.versionRef },
      {
        model: createModel(
          resolveModel("anthropic/claude-sonnet-4-6", modelRegistry),
          modelRegistry,
          anthropicAuth,
        ),
        dataDir: config.dataDir,
        port: skillPackPort,
        contextManager: pipeContextManagers(
          toolResultTruncator({ maxCharsPerResult: 50_000 }),
          autoSummarize({ triggerAt: 100_000, keepRecent: 10 }),
        ),
        zipBuffer:
          ctx.sourceKind === "zip" && ctx.sourceUrl
            ? Buffer.from(ctx.sourceUrl, "base64")
            : undefined,
      },
    ).catch((err) => console.error(`[skill-pack] install failed for ${packId}:`, err));
  },
  triggerSync: (packId, ctx) => {
    void runSync(
      { packId, sourceKind: ctx.sourceKind, sourceUrl: ctx.sourceUrl, versionRef: ctx.versionRef },
      {
        model: createModel(
          resolveModel("anthropic/claude-sonnet-4-6", modelRegistry),
          modelRegistry,
          anthropicAuth,
        ),
        dataDir: config.dataDir,
        port: skillPackPort,
        contextManager: pipeContextManagers(
          toolResultTruncator({ maxCharsPerResult: 50_000 }),
          autoSummarize({ triggerAt: 100_000, keepRecent: 10 }),
        ),
      },
    ).catch((err) => console.error(`[skill-pack] sync failed for ${packId}:`, err));
  },
});

// Feature services
const larkBotRegistry = createLarkBotRegistry(config);
const agentSvc = createAgentSvc(db, config, supervisor, larkBotRegistry, {
  onAgentCreate: (agentId) => skillPackSvc.setAgentPacks(agentId, ["builtin"]),
});
// Idempotent seed — re-runs are no-ops; loop-agent is required by POST /api/loops.
async function ensureAgent(id: string, name: string, model: string) {
  try {
    await agentSvc.getById(id);
  } catch {
    await agentSvc.create({
      id,
      name,
      model: { provider: "anthropic", model },
      permissionMode: "auto",
    });
  }
}
await ensureAgent("default", "Assistant", "claude-sonnet-4-20250514");
await ensureAgent("loop-agent", "Loop Agent", "claude-sonnet-4-20250514");
const relSvc = createRelationshipService(db, config);
const conv = createConversationFeature(
  db,
  config,
  supervisor,
  agentSvc,
  opsStore,
  sessionManager,
  settingsSvc,
  mcpClientManager,
  modelRegistry,
  relSvc,
);

// ─── Event wiring ─────────────────────────────────────────────

// P2: onRunComplete is AWAITED by supervisor — critical sink (ledger terminal write).
// P1: run_finalized already sent before this, so await doesn't block control signal.
supervisor.onRunComplete((_sessionId, spanId, status, kind, errorMessage) => {
  // M19: issue-run isolation now handled by origin_kind in projection/reactor
  return onRunComplete(spanId, status, conv.convPort, conv.convSvc, opsStore, kind, errorMessage);
});

// ─── HTTP router ──────────────────────────────────────────────

const identityStore = createAgentIdentityStore({
  dataDir: config.dataDir,
  getAgent: (id) => agentSvc.getById(id),
});

// Lark-bot setup manager (lazy — created on first setup request)
let setupManager: LarkSetupManager | undefined;
function getSetupManager(provisioner = new CliSetupProvisioner()): LarkSetupManager {
  if (!setupManager) {
    setupManager = new LarkSetupManager(provisioner, async (session) => {
      await agentSvc.update(session.agentId, {
        lark: { enabled: true, botDisplayName: session.botDisplayName ?? undefined },
      });
      await larkBotRegistry.ensureLarkBot(
        session.agentId,
        session.botDisplayName,
        session.profileRef,
      );
      console.log(`[lark-setup] completed for ${session.agentId}, profile=${session.profileRef}`);
    });
  }
  return setupManager;
}

// Ops service — read-only access to checkpoint_events (run-loop is the writer)
import { createCheckpointEventsStore } from "./features/runtime-ops/checkpoint-events-store.js";

let checkpointEventsStore: ReturnType<typeof createCheckpointEventsStore>;
try {
  const checkpointDb = new Database(`${config.dataDir}/checkpointer.db`, { readonly: true });
  checkpointEventsStore = createCheckpointEventsStore(checkpointDb);
} catch (err) {
  if ((err as { code?: string }).code === "SQLITE_CANTOPEN") {
    const noop = () => [];
    checkpointEventsStore = {
      readBySpan: noop,
      readBySession: noop,
      readWindow: noop,
    };
    console.warn(
      `[bootstrap] checkpointer.db not found at ${config.dataDir} — ops fact-events will be empty until the first agent run`,
    );
  } else {
    throw err;
  }
}

const backendDrizzle = drizzle(db, { casing: "snake_case", schema: backendSchema });
const agentNames = new Map<string, string>();
{
  const rows = backendDrizzle
    .select({ id: backendSchema.agents.id, name: backendSchema.agents.name })
    .from(backendSchema.agents)
    .all();
  for (const r of rows) agentNames.set(r.id, r.name);
}
const opsSvc = createRuntimeOpsService({
  opsStore,
  supervisor,
  checkpointEventsStore,
  getAgentName: (agentId) => agentNames.get(agentId),
});

// Project service
const projectPort = sqliteProjectAdapter(db);
const projectSvc = createProjectService({ port: projectPort, idGen: ulid });

const mcpSvc = createMcpService({
  port: sqliteMcpServerAdapter(db),
  mcpClientManager,
  agentExists: (id: string) => agentSvc.exists(id),
  idGen: ulid,
});

// M21: CronJob service
const cronSvc = createCronJobService({
  port: sqliteCronJobAdapter(db),
  idGen: ulid,
  agentExists: (id: string) => agentSvc.exists(id),
  convPort: {
    createConversation: (input) =>
      conv.convPort.createConversation({ ...input, createdAt: Date.now() }),
    addMember: (input) => conv.convPort.addMember({ ...input, joinedAt: Date.now() }),
  },
});

// M21: CronJob scheduler
const cronScheduler = createCronScheduler({
  cronSvc,
  supervisor,
  opsStore,
  config,
  agentSvc,
  idGen: ulid,
  sessionManager,
  store: loopStore,
  modelRegistry,
});

// Resume route for ToolApprovalCard interrupt flow — uses AgentSession.resume()
// spanId → sessionId lookup via opsStore (run table); live session via sessionManager.get
const resumeRun = resumeRoutes({
  sessionManager,
  getSessionIdByRunId: (spanId) => opsStore.getRuns([spanId])[0]?.sessionId ?? null,
});

const app = createApp(config.authToken, {
  resumeRun,

  agents: agentRoutes(
    agentSvc,
    {
      listForAgent: (id: string) =>
        skillPackSvc
          .listForAgent(id)
          .then((rows) => rows.map((r) => ({ id: r.id, name: r.name, status: r.status }))),
      setAgentPacks: (id: string, packIds: string[]) => skillPackSvc.setAgentPacks(id, packIds),
    },
    identityStore,
    (id: string) => larkBotRegistry.statusOf(id),
    getSetupManager,
    relSvc,
    config.dataDir,
  ),
  conversations: conversationRoutes(conv.convSvc, ulid, conv.goalStore),
  ops: opsRoutes(opsSvc),
  projects: projectRoutes(projectSvc),
  loops: loopRoutes(
    cronSvc,
    cronScheduler,
    sqliteCronJobAdapter(db),
    config.dataDir,
    ulid,
    sessionManager,
    (params) => ({
      model: createModel(
        resolveModel(params.modelName, modelRegistry),
        modelRegistry,
        anthropicAuth,
      ),
      tools: [...defaultTools(params.cwd), ...mcpClientManager.getTools("loop-agent")],
      plugins: defaultPlugins(params.cwd, config, params.skillRoots),
      contextManager: defaultContextManager(settingsSvc),
    }),
    loopStore,
    projectPort,
    conv.convPort,
    settingsSvc,
  ),
  cronJobs: cronJobRoutes(cronSvc, cronScheduler),
  skillPacks: skillPackRoutes(skillPackSvc, config.dataDir),
  settings: settingsRoutes(settingsSvc),
  mcp: mcpRoutes(mcpSvc),
  models: modelRoutes(modelRegistry),
});

// ─── Start ────────────────────────────────────────────────────

const server = createServer(config, app);
// rediscover removed — AgentSession runs in-process, no daemon to reattach
server.start();
cronScheduler.start();
console.log(`[backend] listening on ${config.host}:${config.port}`);

// Launch lark-bots for enabled agents
(async () => {
  const allAgents = await agentSvc.list(true);
  for (const agent of allAgents) {
    if (agent.larkEnabled && agent.larkProfileRef) {
      larkBotRegistry
        .ensureLarkBot(agent.id, agent.larkBotDisplayName, agent.larkProfileRef)
        .catch((err) => console.error(`[lark] failed to start bot for ${agent.id}:`, err));
    }
  }
})();

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`[backend] ${signal} received, shutting down...`);
  server.stop();
  supervisor.cancelAll();
  await new Promise((r) => setTimeout(r, config.cancelGraceMs));
  // Stop cron timers/watchdogs before supervisor dispose, so a watchdog
  // or retry firing in the grace window can't touch a closed DB.
  cronScheduler.dispose();
  await supervisor.dispose();
  await larkBotRegistry.dispose();
  setupManager?.dispose();
  await mcpClientManager.disconnectAll();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
