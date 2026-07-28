import { Database } from "bun:sqlite";
import { autoSummarize, pipeContextManagers, toolResultTruncator } from "@my-agent-team/agent";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { FeatureSet } from "../app.js";
import { createAgentSvc } from "../features/agent/agent-compose.js";
import { createAgentIdentityStore } from "../features/agent/agent-identity.js";
import { agentRoutes } from "../features/agent/index.js";
import { createRelationshipService } from "../features/agent/relationship-service.js";
import { createConversationFeature } from "../features/conversation/conversation-compose.js";
import { conversationRoutes } from "../features/conversation/index.js";
import { onRunComplete } from "../features/conversation/run-accumulator.js";
import {
  createCronJobService,
  createCronScheduler,
  cronJobRoutes,
  sqliteCronJobAdapter,
} from "../features/cron/index.js";
import { CliSetupProvisioner, LarkSetupManager } from "../features/lark-bot/index.js";
import { loopRoutes } from "../features/loop/http.js";
import { createMcpService, mcpRoutes, sqliteMcpServerAdapter } from "../features/mcp/index.js";
import { modelRoutes } from "../features/models/index.js";
import {
  createProjectService,
  projectRoutes,
  sqliteProjectAdapter,
} from "../features/project/index.js";
import { createCheckpointEventsStore } from "../features/runtime-ops/checkpoint-events-store.js";
import { createRuntimeOpsService, opsRoutes } from "../features/runtime-ops/index.js";
import { settingsRoutes } from "../features/settings/index.js";
import type { SkillPackRow } from "../features/skill-pack/index.js";
import {
  createSkillPackService as createSkillPackServiceFn,
  runInstall,
  runSync,
  seedSkillPacks,
  setSkillPackPort,
  skillPackRoutes,
  sqliteSkillPackAdapter,
} from "../features/skill-pack/index.js";
import {
  createModel,
  defaultContextManager,
  defaultPlugins,
  defaultTools,
  resolveModel,
} from "../features/span/agent-helpers.js";
import { resumeRoutes } from "../features/span/http.js";
import * as backendSchema from "../infra/db/schema.js";
import { ulid } from "../infra/ids.js";
import type { BackendServices } from "./services.js";

// ─── Helper ───────────────────────────────────────────────────

function createSkillPackModel(services: BackendServices) {
  return createModel(
    resolveModel("anthropic/claude-sonnet-4-6", services.modelRegistry),
    services.modelRegistry,
    services.anthropicAuth,
  );
}

// ─── Installer ────────────────────────────────────────────────

export interface InstalledFeatures {
  featureSet: FeatureSet;
  cronScheduler: ReturnType<typeof createCronScheduler>;

  start(): Promise<void>;
  dispose(): Promise<void>;
}

export async function installFeatures(services: BackendServices): Promise<InstalledFeatures> {
  const {
    config,
    db,
    settingsSvc,
    modelRegistry,
    anthropicAuth,
    mcpClientManager,
    sessionManager,
    supervisor,
    loopStore,
    larkBotRegistry,
  } = services;

  // ─── Skill Pack (before agentSvc — onCreate depends on it) ──

  const skillPackPort = sqliteSkillPackAdapter(db);
  setSkillPackPort(skillPackPort);

  await seedSkillPacks({
    port: skillPackPort,
    dataDir: config.dataDir,
    builtinSkillsDir: config.builtinSkillsDir,
  });

  const skillPackModel = createSkillPackModel(services);
  const skillPackContext = pipeContextManagers(
    toolResultTruncator({ maxCharsPerResult: 50_000 }),
    autoSummarize({ triggerAt: 100_000, keepRecent: 10 }),
  );

  const skillPackSvc = createSkillPackServiceFn({
    port: skillPackPort,
    idGen: ulid,
    triggerInstall: (packId, ctx) => {
      void runInstall(
        {
          packId,
          sourceKind: ctx.sourceKind,
          sourceUrl: ctx.sourceUrl,
          versionRef: ctx.versionRef,
        },
        {
          model: skillPackModel,
          dataDir: config.dataDir,
          port: skillPackPort,
          contextManager: skillPackContext,
          zipBuffer:
            ctx.sourceKind === "zip" && ctx.sourceUrl
              ? Buffer.from(ctx.sourceUrl, "base64")
              : undefined,
        },
      ).catch((err: Error) => console.error(`[skill-pack] install failed for ${packId}:`, err));
    },
    triggerSync: (packId, ctx) => {
      void runSync(
        {
          packId,
          sourceKind: ctx.sourceKind,
          sourceUrl: ctx.sourceUrl,
          versionRef: ctx.versionRef,
        },
        {
          model: skillPackModel,
          dataDir: config.dataDir,
          port: skillPackPort,
          contextManager: skillPackContext,
        },
      ).catch((err: Error) => console.error(`[skill-pack] sync failed for ${packId}:`, err));
    },
  });

  // ─── Agent service ──────────────────────────────────────────

  const agentSvc = createAgentSvc(db, config, supervisor, larkBotRegistry, {
    onAgentCreate: (agentId: string) => skillPackSvc.setAgentPacks(agentId, ["builtin"]),
  });

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

  // ─── Conversation ───────────────────────────────────────────

  const conv = createConversationFeature(
    db,
    config,
    supervisor,
    agentSvc,
    services.opsStore,
    sessionManager,
    settingsSvc,
    mcpClientManager,
    modelRegistry,
    relSvc,
  );

  // ─── Event wiring ───────────────────────────────────────────

  supervisor.onRunComplete(
    (_sessionId: string, spanId: string, status: string, kind?: string, errorMessage?: string) => {
      return onRunComplete(
        spanId,
        status,
        conv.convPort,
        conv.convSvc,
        services.opsStore,
        kind,
        errorMessage,
      );
    },
  );

  // ─── Identity store + Lark setup ────────────────────────────

  const identityStore = createAgentIdentityStore({
    dataDir: config.dataDir,
    getAgent: (id: string) => agentSvc.getById(id),
  });

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

  // ─── Runtime Ops ────────────────────────────────────────────

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
    opsStore: services.opsStore,
    supervisor,
    checkpointEventsStore,
    getAgentName: (agentId: string) => agentNames.get(agentId),
  });

  // ─── Project ────────────────────────────────────────────────

  const projectPort = sqliteProjectAdapter(db);
  const projectSvc = createProjectService({ port: projectPort, idGen: ulid });

  // ─── MCP ────────────────────────────────────────────────────

  const mcpSvc = createMcpService({
    port: sqliteMcpServerAdapter(db),
    mcpClientManager,
    agentExists: (id: string) => agentSvc.exists(id),
    idGen: ulid,
  });

  // ─── Cron ───────────────────────────────────────────────────

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

  const cronScheduler = createCronScheduler({
    cronSvc,
    supervisor,
    opsStore: services.opsStore,
    config,
    agentSvc,
    idGen: ulid,
    sessionManager,
    store: loopStore,
    modelRegistry,
  });

  // ─── Resume ─────────────────────────────────────────────────

  const resumeRun = resumeRoutes({
    sessionManager,
    getSessionIdByRunId: (spanId: string) =>
      services.opsStore.getRuns([spanId])[0]?.sessionId ?? null,
  });

  // ─── FeatureSet ─────────────────────────────────────────────

  const featureSet: FeatureSet = {
    resumeRun,
    agents: agentRoutes(
      agentSvc,
      {
        listForAgent: (id: string) =>
          skillPackSvc
            .listForAgent(id)
            .then((rows: SkillPackRow[]) =>
              rows.map((r) => ({ id: r.id, name: r.name, status: r.status })),
            ),
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
      (params: { modelName: string; cwd: string; skillRoots?: unknown }) => ({
        model: createModel(
          resolveModel(params.modelName, modelRegistry),
          modelRegistry,
          anthropicAuth,
        ),
        tools: [...defaultTools(params.cwd), ...mcpClientManager.getTools("loop-agent")],
        plugins: defaultPlugins(
          params.cwd,
          config,
          params.skillRoots as Parameters<typeof defaultPlugins>[2],
        ),
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
  };

  // ─── Lifecycle ──────────────────────────────────────────────

  async function start(): Promise<void> {
    cronScheduler.start();

    const allAgents = await agentSvc.list(true);
    for (const agent of allAgents) {
      if (agent.larkEnabled && agent.larkProfileRef) {
        void larkBotRegistry
          .ensureLarkBot(agent.id, agent.larkBotDisplayName, agent.larkProfileRef)
          .catch((err: Error) => console.error(`[lark] failed to start bot for ${agent.id}:`, err));
      }
    }
  }

  async function dispose(): Promise<void> {
    cronScheduler.dispose();
    await larkBotRegistry.dispose();
    setupManager?.dispose();
  }

  return { featureSet, cronScheduler, start, dispose };
}
