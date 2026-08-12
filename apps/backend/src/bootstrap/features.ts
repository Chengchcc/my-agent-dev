import { CodingAgentBackend, CodingAgentModelCatalog } from "@my-agent-team/adapter-coding-agent";
import type { Message } from "@my-agent-team/message";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { FeatureSet } from "../app.js";
import { createAgentSvc } from "../features/agent/agent-compose.js";
import { createAgentIdentityStore } from "../features/agent/agent-identity.js";
import { AgentBusyError, agentModelRef, agentRoutes } from "../features/agent/index.js";
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
import { modelRoutes } from "../features/models/index.js";
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
  installPath,
  runInstall,
  runSync,
  seedSkillPacks,
  setSkillPackPort,
  skillPackRoutes,
  sqliteSkillPackAdapter,
} from "../features/skill-pack/index.js";
import { resolveCodingAgentCommand } from "../infra/coding-agent-command.js";
import * as backendSchema from "../infra/db/schema.js";
import { ulid } from "../infra/ids.js";
import type { BackendServices } from "./services.js";

// ─── Helper ───────────────────────────────────────────────────

/** Frozen system prompt from the Agent's editable identity files:
 *  SOUL.md as the identity, USER.md as the user context. */
export function buildAgentSystemPrompt(
  soul: string | null,
  user: string | null,
): string | undefined {
  const parts: string[] = [];
  if (soul) parts.push(soul);
  if (user) parts.push(`User context:\n${user}`);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

// ─── Installer ────────────────────────────────────────────────

export interface InstalledFeatures {
  featureSet: FeatureSet;
  cronScheduler: ReturnType<typeof createCronScheduler>;
  /** Phase 5 internal handles (not exposed via HTTP). */
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

  // ─── Conversation + Phase 5 Agent Run (conversation first: the ledger
  //      resolver and run services build on its port; the execution service
  //      is wired last through dispatchRun to break the cascade cycle) ──

  const convPort = sqliteConversationAdapter(db);

  const ledgerResolver: LedgerMessageResolver = {
    async resolveMessage(conversationId, ledgerSeq) {
      const entry = convPort.getLedgerEntry(conversationId, ledgerSeq);
      if (entry?.kind !== "message") return null;
      // getLedgerEntry returns content already parsed (port type lies).
      return (entry.content as unknown as Message) ?? null;
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
  // Agent identity (SOUL.md/USER.md) is read at Run creation and FROZEN into
  // the Run snapshot; dispatch never re-resolves it.
  const identityStore = createAgentIdentityStore({
    dataDir: config.dataDir,
    getAgent: (id: string) => agentSvc.getById(id),
  });
  const agentRunService = createAgentRunService({
    port: agentRunPort,
    contextService: contextSvc,
    idGen: { ulid },
    ledgerResolver,
    // Default frozen Run config: the target Agent's identity (SOUL.md +
    // USER.md) and its assigned READY skill packs. Loop scopes pass their
    // own LOOP.md config explicitly and skip this resolver.
    resolveRunConfig: async ({ conversationId, agentMemberId }) => {
      const members = conv.convPort.getMembers(conversationId);
      const member = members.find((m) => m.memberId === agentMemberId);
      const agentId = member?.agentId;
      if (!agentId) return {};
      const identity = await identityStore.getIdentity(agentId);
      const systemPrompt = buildAgentSystemPrompt(identity.soul, identity.user);
      const packs = await skillPackPort.listForAgent(agentId);
      const skillRoots = packs
        .filter((p) => p.status === "ready")
        .map((p) => installPath(config.dataDir, p.id));
      return {
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(skillRoots.length > 0 ? { skillRoots } : {}),
      };
    },
  });

  const dispatchRun: { fn: (runId: string) => Promise<void> } = { fn: async () => {} };
  const injectSteer: {
    fn: (branchId: string, input: { inputId: string; message: Message }) => Promise<void>;
  } = { fn: async () => {} };
  const isLive: { fn: (runId: string) => boolean } = { fn: () => false };
  const isInflight: { fn: (runId: string) => boolean } = { fn: () => false };
  const abortStaleRun: { fn: (runId: string) => Promise<void> } = { fn: async () => {} };
  const conv = createConversationFeature({
    convPort,
    agentSvc,
    settingsSvc,
    relSvc,
    agentRunService,
    dispatchRun: (runId: string) => dispatchRun.fn(runId),
    injectSteer: (branchId, input) => injectSteer.fn(branchId, input),
    isLive: (runId: string) => isLive.fn(runId),
    isInflight: (runId: string) => isInflight.fn(runId),
    abortStaleRun: (runId: string) => abortStaleRun.fn(runId),
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

  // The execution service exists unconditionally: the Coding Agent is a
  // child process (one Run = one spawn). When the executable is missing,
  // startup continues - /api/models errors and Run dispatch keeps the input
  // unaccepted until the executable exists.
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
      // Persist auto-generated title (first Run only; !convRow.title guard).
      const convRow = conv.convPort.getConversation(run.conversationId);
      const outcome = run.terminalResult;
      if (convRow && !convRow.title && outcome?.status === "completed" && outcome.title) {
        conv.convPort.setConversationTitle(run.conversationId, outcome.title);
      }
    })().catch((err) => console.error(`[bootstrap] onRunCommitted failed for ${runId}:`, err));
  };
  const codingAgentCommand = resolveCodingAgentCommand(config);
  const modelCatalog = new CodingAgentModelCatalog(codingAgentCommand);
  const codingAgentBackend = new CodingAgentBackend(codingAgentCommand, {
    maxConcurrent: config.maxConcurrentRuns,
    abortGraceMs: config.cancelGraceMs,
  });
  const agentRunExecution = createAgentRunExecutionService({
    runPort: agentRunPort,
    contextPort,
    ledgerResolver,
    backend: codingAgentBackend,
    modelCatalog,
    idGen: { ulid },
    resolveWorkspace: async ({ conversationId, agentMemberId }) => {
      // Default workspace comes from the agent member's Agent record;
      // Loop scopes pin their workspace as a Run fact at enqueue time.
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

  dispatchRun.fn = (runId: string) => agentRunExecution.dispatch(runId);
  injectSteer.fn = (branchId: string, input: { inputId: string; message: Message }) =>
    agentRunExecution.injectSteer(branchId, input);
  isLive.fn = (runId: string) => agentRunExecution.isLive(runId);
  isInflight.fn = (runId: string) => agentRunExecution.isInflight(runId);
  abortStaleRun.fn = (runId: string) => agentRunExecution.abortStaleRun(runId);

  // ─── Lark setup ────────────────────────────────────────────
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
      return agentModelRef(await agentSvc.getById(agentId));
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
      // LOOP.md stores the full canonical model ID; pass it through.
      resolveModel: async (modelId: string) => ({
        backendKind: "coding_agent",
        modelId,
      }),
      settingsSvc,
    }),
    cronJobs: cronJobRoutes(cronSvc, cronScheduler),
    skillPacks: skillPackRoutes(skillPackSvc, config.dataDir),
    settings: settingsRoutes(settingsSvc),
    mcp: mcpRoutes(mcpSvc),
    models: modelRoutes({
      list: async () => {
        // Catalog returns composite `<provider>/<model>` ids; grouping and
        // prefix-stripping happen once in modelRoutes.groupByProvider.
        const catalog = await modelCatalog.list();
        return catalog.models.map((m) => ({
          id: m.id,
          name: m.displayName ?? m.id,
          available: m.available,
          reasoning: m.reasoning,
          input: m.inputModalities,
          cost: m.cost,
          contextWindow: m.contextWindow,
          maxTokens: m.maxOutputTokens,
        }));
      },
    }),
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

    // Phase 5: redeliver durable delivering inputs, promote idle-branch
    // pending inputs, and retry commit_failed runs once at boot.
    await agentRunExecution.recover();
  }

  async function dispose(): Promise<void> {
    // Order matters: stop producing Runs first, then kill every Coding
    // Agent child and drain in-flight dispatches (the DB must not close
    // mid-finalize), THEN close surfaces that children may still call
    // (Product Tools MCP) and finally Lark/setup.
    cronScheduler.dispose(); // no new Runs
    await agentRunExecution.dispose(); // abort/SIGTERM/SIGKILL children + drain
    await larkBotRegistry.dispose();
    setupManager?.dispose();
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
