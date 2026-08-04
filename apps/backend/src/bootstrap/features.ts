import {
  CodingAgentBackend,
  CodingAgentClient,
  CodingAgentModelCatalog,
} from "@my-agent-team/adapter-coding-agent";
import type { Message } from "@my-agent-team/message";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Elysia } from "elysia";
import type { FeatureSet } from "../app.js";

function staticModelsRoutes() {
  return new Elysia().get("/api/models", () => ({
    providers: [
      {
        id: "coding_agent",
        name: "Coding Agent",
        models: [{ id: "claude-sonnet-4-20250514", name: "claude-sonnet-4-20250514" }],
      },
    ],
  }));
}
import { createAgentSvc } from "../features/agent/agent-compose.js";
import { createAgentIdentityStore } from "../features/agent/agent-identity.js";
import { AgentBusyError, agentRoutes } from "../features/agent/index.js";
import { createRelationshipService } from "../features/agent/relationship-service.js";
import {
  createAgentContextService,
  sqliteAgentContextAdapter,
} from "../features/agent-context/index.js";
import type { LedgerMessageResolver } from "../features/agent-context/ports.js";
import {
  agentRunRoutes,
  createAgentRunExecutionService,
  createAgentRunService,
  sqliteAgentRunAdapter,
} from "../features/agent-run/index.js";
import { createConversationFeature } from "../features/conversation/conversation-compose.js";
import { conversationRoutes, sqliteConversationAdapter } from "../features/conversation/index.js";
import {
  createCronJobService,
  createCronScheduler,
  cronJobRoutes,
  sqliteCronJobAdapter,
} from "../features/cron/index.js";
import { CliSetupProvisioner, LarkSetupManager } from "../features/lark-bot/index.js";
import { loopRoutes } from "../features/loop/http.js";
import { createMcpService, mcpRoutes, sqliteMcpServerAdapter } from "../features/mcp/index.js";
import {
  createProductToolsMcpServer,
  createProductToolsService,
  sqliteProductToolCallAdapter,
} from "../features/product-tools/index.js";
import {
  createProjectService,
  projectRoutes,
  sqliteProjectAdapter,
} from "../features/project/index.js";
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
import * as backendSchema from "../infra/db/schema.js";
import { ulid } from "../infra/ids.js";
import type { BackendServices } from "./services.js";

// ─── Helper ───────────────────────────────────────────────────

// ─── Installer ────────────────────────────────────────────────

export interface InstalledFeatures {
  featureSet: FeatureSet;
  cronScheduler: ReturnType<typeof createCronScheduler>;
  /** Phase 4 internal handles for Phase 5 callers (not exposed via HTTP). */
  agentRunService: ReturnType<typeof createAgentRunService>;
  agentRunExecution: ReturnType<typeof createAgentRunExecutionService>;
  productTools: ReturnType<typeof createProductToolsService>;

  start(): Promise<void>;
  dispose(): Promise<void>;
}

export async function installFeatures(services: BackendServices): Promise<InstalledFeatures> {
  const { config, db, settingsSvc, mcpClientManager, loopStore, larkBotRegistry } = services;

  // ─── Skill Pack (before agentSvc — onCreate depends on it) ──

  const skillPackPort = sqliteSkillPackAdapter(db);
  setSkillPackPort(skillPackPort);

  await seedSkillPacks({
    port: skillPackPort,
    dataDir: config.dataDir,
    builtinSkillsDir: config.builtinSkillsDir,
  });

  // Deterministic Skill Pack install/sync: no model, no Agent session.
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
          dataDir: config.dataDir,
          port: skillPackPort,
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
          dataDir: config.dataDir,
          port: skillPackPort,
        },
      ).catch((err: Error) => console.error(`[skill-pack] sync failed for ${packId}:`, err));
    },
  });

  // ─── Agent service ──────────────────────────────────────────

  // Busy guard for hardDelete is wired after the Agent Run adapter exists.
  const busyGuard: { check: ((agentId: string) => void) | undefined } = { check: undefined };
  const agentSvc = createAgentSvc(db, config, larkBotRegistry, {
    onAgentCreate: (agentId: string) => skillPackSvc.setAgentPacks(agentId, ["builtin"]),
    assertNoActiveRun: (agentId: string) => busyGuard.check?.(agentId),
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

  // ─── Conversation + Phase 4 Agent Run (conversation first: the ledger
  //      resolver and run services build on its port; the execution service
  //      is wired last through dispatchRun to break the cascade cycle) ──

  const convPort = sqliteConversationAdapter(db);

  const ledgerResolver: LedgerMessageResolver = {
    async resolveMessage(conversationId, ledgerSeq) {
      const entries = convPort.getLedgerEntries(conversationId, { sinceSeq: ledgerSeq });
      const hit = entries.find((e) => e.seq === ledgerSeq);
      if (hit?.kind !== "message") return null;
      // getLedgerEntries returns content already parsed (port type lies).
      return (hit.content as unknown as Message) ?? null;
    },
  };

  const contextPort = sqliteAgentContextAdapter(db, { ulid });
  const contextSvc = createAgentContextService({
    port: contextPort,
    idGen: { ulid },
    ledgerResolver,
  });
  const agentRunPort = sqliteAgentRunAdapter(db, { contextPort, ledgerResolver, idGen: { ulid } });
  busyGuard.check = (agentId: string) => {
    const row = db
      .query(
        `SELECT 1 FROM agent_run
         WHERE agent_member_id IN (SELECT member_id FROM member WHERE agent_id = ?)
           AND status IN ('running','waiting','commit_failed') LIMIT 1`,
      )
      .get(agentId);
    if (row) throw new AgentBusyError(agentId);
  };
  const agentRunService = createAgentRunService({
    port: agentRunPort,
    contextService: contextSvc,
    idGen: { ulid },
    ledgerResolver,
  });

  const dispatchRun: { fn: (runId: string) => Promise<void> } = { fn: async () => {} };
  const conv = createConversationFeature({
    convPort,
    agentSvc,
    settingsSvc,
    relSvc,
    agentRunService,
    dispatchRun: (runId: string) => dispatchRun.fn(runId),
    contextService: contextSvc,
  });

  // Product Tools (History) - assembled unconditionally so the MCP endpoint
  // and the execution manifest are consistent; the MCP server only listens
  // when a URL is configured.
  const productTools = createProductToolsService({
    runPort: agentRunPort,
    contextPort,
    conversationPort: convPort,
    callPort: sqliteProductToolCallAdapter(db),
    idGen: { ulid },
  });
  let productToolsMcp: Awaited<ReturnType<typeof createProductToolsMcpServer>> | null = null;
  if (config.productToolsMcpUrl && config.productToolsServiceToken) {
    const mcpUrl = new URL(config.productToolsMcpUrl);
    productToolsMcp = await createProductToolsMcpServer({
      service: productTools,
      serviceToken: config.productToolsServiceToken,
      host: mcpUrl.hostname,
      port: Number(mcpUrl.port) || 0,
    });
    console.log(`[bootstrap] product tools MCP listening at ${productToolsMcp.url}`);
  }

  // The execution service exists only when the Coding Agent daemon is
  // configured; without it recover() is a no-op and Phase 5 callers still
  // have the service handle for enqueue/query.
  let agentRunExecution: ReturnType<typeof createAgentRunExecutionService>;
  const onRunCommitted = (runId: string, output: Message | undefined): void => {
    void (async () => {
      const run = await agentRunPort.getRun(runId);
      if (!run || !output) return;
      await conv.convSvc.cascadeMentionedAgents({
        conversationId: run.conversationId,
        sourceRunId: runId,
        senderMemberId: run.agentMemberId,
        message: output,
      });
    })().catch((err) => console.error(`[bootstrap] mention cascade failed for ${runId}:`, err));
  };
  if (config.codingAgentUrl && config.codingAgentServiceToken) {
    const client = new CodingAgentClient({
      baseUrl: config.codingAgentUrl,
      authToken: config.codingAgentServiceToken,
    });
    agentRunExecution = createAgentRunExecutionService({
      runPort: agentRunPort,
      contextPort,
      ledgerResolver,
      backend: new CodingAgentBackend(client),
      modelCatalog: new CodingAgentModelCatalog(client),
      idGen: { ulid },
      resolveWorkspace: async ({ conversationId, agentMemberId }) => {
        // Workspace comes from the agent member's Agent record; the
        // permission mode maps to the binding (auto -> read_write).
        const members = conv.convPort.getMembers(conversationId);
        const member = members.find((m) => m.memberId === agentMemberId);
        const agent = member?.agentId ? await agentSvc.getById(member.agentId) : null;
        return {
          root: agent?.workspacePath ?? config.workspaceRoot,
          access: agent?.permissionMode === "ask" ? "read_only" : "read_write",
        };
      },
      productToolsEntrypoint: config.productToolsMcpUrl
        ? `sse:${config.productToolsMcpUrl}`
        : "stdio:/nonexistent",
      onRunCommitted,
    });
  } else {
    agentRunExecution = createAgentRunExecutionService({
      runPort: agentRunPort,
      contextPort,
      ledgerResolver,
      backend: new CodingAgentBackend(
        new CodingAgentClient({ baseUrl: "http://127.0.0.1:1", authToken: "unconfigured" }),
      ),
      modelCatalog: new CodingAgentModelCatalog(
        new CodingAgentClient({ baseUrl: "http://127.0.0.1:1", authToken: "unconfigured" }),
      ),
      idGen: { ulid },
      resolveWorkspace: async () => ({ root: config.workspaceRoot, access: "read_write" }),
      productToolsEntrypoint: "stdio:/nonexistent",
      onRunCommitted,
    });
    console.warn(
      "[bootstrap] CODING_AGENT_URL not configured - Agent Run execution is inert until Phase 5 wiring",
    );
  }

  dispatchRun.fn = (runId: string) => agentRunExecution.dispatch(runId);

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

  // ─── Runtime Ops (surface-health audit only) ───────────────

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
    config,
    convPort,
    agentRunService,
    agentRunExecution,
    resolveDefaultModel: async (agentId: string) => {
      const agent = await agentSvc.getById(agentId);
      return { backendKind: "coding_agent", modelId: agent.modelName };
    },
    store: loopStore,
    projectPort,
  });

  // ─── FeatureSet ─────────────────────────────────────────────

  const featureSet: FeatureSet = {
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
    agentRuns: agentRunRoutes({ db, agentRunService, agentRunExecution }),
    projects: projectRoutes(projectSvc),
    loops: loopRoutes({
      cronSvc,
      scheduler: cronScheduler,
      dataDir: config.dataDir,
      store: loopStore,
      projectPort,
      convPort,
      agentRunService,
      agentRunExecution,
      resolveModel: async (modelName: string) => ({
        backendKind: "coding_agent",
        modelId: modelName,
      }),
      settingsSvc,
    }),
    cronJobs: cronJobRoutes(cronSvc, cronScheduler),
    skillPacks: skillPackRoutes(skillPackSvc, config.dataDir),
    settings: settingsRoutes(settingsSvc),
    mcp: mcpRoutes(mcpSvc),
    models: new Elysia().get("/api/models", () => ({
      providers: [
        {
        id: "coding_agent",
        name: "Coding Agent",
        models: [{ id: "claude-sonnet-4-20250514", name: "claude-sonnet-4-20250514" }],
      },
      ],
    })),
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

    // Phase 4: redeliver durable delivering inputs and retry commit_failed
    // runs once at boot (no scheduler, no lease).
    await agentRunExecution.recover();
  }

  async function dispose(): Promise<void> {
    cronScheduler.dispose();
    await larkBotRegistry.dispose();
    setupManager?.dispose();
    // Phase 4: close the Product Tools MCP server (live run segments are
    // one-shot daemon Workers; the daemon shuts them down on its own exit).
    await productToolsMcp?.close();
  }

  return {
    featureSet,
    cronScheduler,
    agentRunService,
    agentRunExecution,
    productTools,
    start,
    dispose,
  };
}
