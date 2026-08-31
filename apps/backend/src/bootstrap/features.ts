import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ClaudeBackend, ClaudeModelCatalog } from "@chengchenccc/adapter-claude-agent";
import { OmaBackend, OmaModelCatalog } from "@chengchenccc/adapter-oma-agent";
import { OmpBackend, OmpModelCatalog } from "@chengchenccc/adapter-omp-agent";
import { PiBackend, PiModelCatalog } from "@chengchenccc/adapter-pi-agent";
import type {
  BackendKind,
  BackendRegistry,
  BackendRegistryEntry,
} from "@chengchenccc/agent-contract";
import { resolveModelAlias } from "@chengchenccc/ai";
import { type Message, serializeMessageRevision } from "@chengchenccc/message";
import type { WorkflowDefinition } from "@chengchenccc/workflow";
import type { FeatureSet } from "../app.js";
import { createAgentSvc } from "../features/agent/agent-compose.js";
import { createAgentIdentityStore } from "../features/agent/agent-identity.js";
import { AgentBusyError, agentModelRef, agentRoutes } from "../features/agent/index.js";
import { reconcileAgentResources } from "../features/agent/workspace-bridge.js";
import {
  createAgentContextService,
  sqliteAgentContextAdapter,
} from "../features/agent-context/index.js";
import type { LedgerMessageResolver } from "../features/agent-context/ports.js";
import {
  agentRunRoutes,
  buildHistoryTools,
  createAgentRunExecutionService,
  createAgentRunService,
  sqliteAgentRunAdapter,
} from "../features/agent-run/index.js";
import {
  artifactRoutes,
  createArtifactFsAdapter,
  createArtifactService,
} from "../features/artifact/index.js";
import { createConversationFeature } from "../features/conversation/conversation-compose.js";
import { conversationRoutes, sqliteConversationAdapter } from "../features/conversation/index.js";
import {
  createKnowledgeService,
  knowledgeRoutes,
  sqliteKnowledgePackAdapter,
} from "../features/knowledge/index.js";
import { CliSetupProvisioner, LarkSetupManager } from "../features/lark-bot/index.js";
import { createMcpService, fileMcpServerAdapter, mcpRoutes } from "../features/mcp/index.js";
import { modelRoutes } from "../features/models/index.js";
import {
  createProductToolsMcpServer,
  createProductToolsService,
  sqliteProductToolCallAdapter,
} from "../features/product-tools/index.js";
import { createRunTokenRegistry } from "../features/product-tools/run-token-registry.js";
import {
  createProjectService,
  projectRoutes,
  sqliteProjectAdapter,
} from "../features/project/index.js";
import { createWorkspaceLockRegistry } from "../features/project/workspace-lock.js";
import { ensureMirror, ensureWorktree, removeWorktree } from "../features/project/worktree.js";
import { createWorktreeOps } from "../features/project/worktree-ops.js";
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
import {
  createNodeRunners,
  createWorkflowExecutionService,
  createWorkflowTriggerScheduler,
  ExecutionEventBus,
  sqliteWorkflowExecutionAdapter,
  workflowRoutes,
} from "../features/workflow/index.js";
import { ulid } from "../infra/ids.js";
import { resolveKnowledgeMcpServerEntry } from "../infra/knowledge-mcp-command.js";
import { resolveOmaCommand } from "../infra/oma-command.js";
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
  /** Phase 5 internal handles (not exposed via HTTP). */
  agentRunService: ReturnType<typeof createAgentRunService>;
  agentRunExecution: ReturnType<typeof createAgentRunExecutionService>;
  productTools: ReturnType<typeof createProductToolsService>;
  workflowExecutionService: ReturnType<typeof createWorkflowExecutionService>;

  start(): Promise<void>;
  dispose(): Promise<void>;
}

export async function installFeatures(services: BackendServices): Promise<InstalledFeatures> {
  const { config, db, settingsSvc, mcpClientManager, larkBotRegistry } = services;

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
  /** Shared per-worktree lock registry (A4): run dispatch, loop
   *  clean-start/reset and agent detach serialize on the same roots. */
  const workspaceLocks = createWorkspaceLockRegistry();

  // Workspace bridge (ADR 0003 decision 3): reconcile skills/mcp into the
  // agent workspace. Late-bound (mcpSvc is created further down).
  const reconcileAgent: {
    fn: (agentId: string, prevProjects?: string[]) => Promise<void>;
  } = { fn: async () => {} };
  const agentSvc = createAgentSvc(db, config, larkBotRegistry, {
    onAgentCreate: async (agentId: string) => {
      await skillPackSvc.setAgentPacks(agentId, ["builtin"]);
      await reconcileAgent.fn(agentId);
    },
    onAgentUpdate: (agentId: string, prevProjects: string[]) =>
      reconcileAgent.fn(agentId, prevProjects),
    assertNoActiveRun: (agentId: string) => busyGuard.check?.(agentId),
  });

  async function ensureAgent(id: string, name: string, model: { provider: string; model: string }) {
    try {
      await agentSvc.getById(id);
    } catch {
      await agentSvc.create({
        id,
        name,
        model,
        permissionMode: "auto",
      });
    }
  }

  /** Seed model + provider derive from the live catalog (single source of
   *  truth) — catalog evolution changes the default without touching this
   *  file. Picks the FIRST available model across all providers (the user's
   *  configured provider keys determine which appear). When no provider has
   *  a key yet (clean machine), seeds a placeholder so agents still exist
   *  and get configured later in the UI. */
  async function defaultSeedModel(): Promise<{ provider: string; model: string }> {
    try {
      const catalog = await codingAgentCatalog.list();
      const first = catalog.models.find((m) => m.available !== false);
      if (first) {
        const slash = first.id.indexOf("/");
        if (slash > 0) {
          return { provider: first.id.slice(0, slash), model: first.id.slice(slash + 1) };
        }
      }
    } catch (err) {
      console.warn(
        "[bootstrap] seed model catalog failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    // ponytail: placeholder until a provider key is configured. Agents
    // exist with identity/memory/skills; dispatch fails until the user
    // picks a real model in the UI.
    return { provider: "unconfigured", model: "none" };
  }

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
         WHERE agent_id = ?
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
    resolveRunConfig: async ({ agentId }) => {
      if (!agentId) return {};
      const identity = await identityStore.getIdentity(agentId);
      const systemPrompt = buildAgentSystemPrompt(identity.soul, identity.user);
      const packs = await skillPackPort.listForAgent(agentId);
      const packRoots = packs
        .filter((p) => p.status === "ready")
        .map((p) => installPath(config.dataDir, p.id));
      // The builtin skills (capability docs: workflow authoring, loop
      // workflow) are ALWAYS available - assigned packs add on top.
      const skillRoots = [config.builtinSkillsDir, ...packRoots];
      const result: {
        systemPrompt?: string;
        skillRoots?: readonly string[];
        permissionMode?: string;
      } = {};
      if (systemPrompt) result.systemPrompt = systemPrompt;
      if (skillRoots.length > 0) result.skillRoots = skillRoots;
      const agent = await agentSvc.getById(agentId).catch(() => null);
      if (agent) result.permissionMode = agent.config.runtime_config.permission_mode;
      return result;
    },
    resolveAgentEnabled: async ({ agentId }) => {
      if (!agentId) return true; // loop synthetic scope (no agent row)
      const agent = await agentSvc.getById(agentId).catch(() => null);
      return agent?.config.enabled ?? true;
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
    agentRunService,
    dispatchRun: (runId: string) => dispatchRun.fn(runId),
    injectSteer: (branchId, input) => injectSteer.fn(branchId, input),
    isLive: (runId: string) => isLive.fn(runId),
    isInflight: (runId: string) => isInflight.fn(runId),
    abortStaleRun: (runId: string) => abortStaleRun.fn(runId),
    contextService: contextSvc,
  });

  // Artifact storage (shared across agents, workspaces, workflows).
  const artifactService = createArtifactService(
    createArtifactFsAdapter(join(config.dataDir, "artifacts")),
  );

  // Product Tools (History) - assembled unconditionally so the MCP endpoint
  // and the execution manifest are consistent; the MCP server only listens
  // when a URL is configured.
  const productTools = createProductToolsService({
    runPort: agentRunPort,
    contextPort,
    conversationPort: convPort,
    callPort: sqliteProductToolCallAdapter(db),
    idGen: { ulid },
    artifactService,
  });
  let productToolsMcp: Awaited<ReturnType<typeof createProductToolsMcpServer>> | null = null;
  // Per-run bearer registry: tokens are minted at dispatch and revoked at
  // settle (agent-run execution); this is the ONLY accepted MCP auth.
  const productToolsTokenRegistry = createRunTokenRegistry();
  if (config.productToolsMcpUrl) {
    const mcpUrl = new URL(config.productToolsMcpUrl);
    productToolsMcp = await createProductToolsMcpServer({
      service: productTools,
      tokenRegistry: productToolsTokenRegistry,
      host: mcpUrl.hostname,
      port: Number(mcpUrl.port) || 0,
    });
    console.log(`[bootstrap] product tools MCP listening at ${productToolsMcp.url}`);
  }

  // The execution service exists unconditionally: the Oma is a
  // child process (one Run = one spawn). When the executable is missing,
  // startup continues - /api/models errors and Run dispatch keeps the input
  // unaccepted until the executable exists.
  // T3-2: failed/aborted/timeout runs persist an assistant error message so
  // the failure survives refresh (transient bubbles die with the page).
  const onRunFailed = (input: {
    runId: string;
    conversationId: string;
    agentId: string;
    error: string;
  }): void => {
    void (async () => {
      const msg = {
        messageId: `run:${input.runId}:error`,
        state: "error" as const,
        role: "assistant" as const,
        text: input.error,
        visibility: "conversation" as const,
        conversationId: input.conversationId,
        updatedAt: Date.now(),
        error: { message: input.error },
      };
      conv.convPort.appendLedgerEntry({
        conversationId: input.conversationId,
        senderMemberId: input.agentId,
        addressedTo: [],
        kind: "message",
        content: serializeMessageRevision(msg),
        ts: Date.now(),
      });
    })().catch((err) => console.error(`[bootstrap] onRunFailed failed for ${input.runId}:`, err));
  };
  const onRunCommitted = (runId: string, output: Message | undefined): void => {
    void (async () => {
      const run = await agentRunPort.getRun(runId);
      if (!run || !output) return;
      // Persist auto-generated title (first Run only; !convRow.title guard).
      const convRow = conv.convPort.getConversation(run.conversationId);
      const outcome = run.terminalResult;
      if (convRow && !convRow.title && outcome?.status === "completed" && outcome.title) {
        conv.convPort.setConversationTitle(run.conversationId, outcome.title);
      }
    })().catch((err) => console.error(`[bootstrap] onRunCommitted failed for ${runId}:`, err));
  };
  const codingAgentCommand = resolveOmaCommand(config);
  const codingAgentCatalog = new OmaModelCatalog(codingAgentCommand);

  const codingAgentBackend = new OmaBackend(codingAgentCommand, {
    maxConcurrent: config.maxConcurrentRuns,
    abortGraceMs: config.cancelGraceMs,
  });
  // Per-kind dispatch registry (ADR 0002). New kinds (claude_code/pi/omp)
  // register their adapter here as they land; unknown kinds get a clear
  // preflight error from the execution service, never a silent fallback.
  const ompBackend = new OmpBackend({
    executable: config.ompBin ?? "omp",
  });
  const piBackend = new PiBackend({
    executable: config.piBin ?? "pi",
    // `pi install npm:pi-mcp-adapter` registers the adapter; an explicit
    // path overrides it for per-run spawns (D3 全量对齐).
    mcpAdapterPath: config.piMcpAdapterPath,
  });
  const claudeBackend = new ClaudeBackend({
    executable: config.claudeBin ?? "claude",
    // bypassPermissions is refused under root; CLAUDE_PERMISSION_MODE
    // on non-root deployments (Gate 0).
    permissionMode: config.claudePermissionMode,
  });
  const backends: BackendRegistry = {
    oma: { backend: codingAgentBackend, catalog: codingAgentCatalog },
    omp: { backend: ompBackend, catalog: new OmpModelCatalog() },
    pi: { backend: piBackend, catalog: new PiModelCatalog() },
    claude_code: { backend: claudeBackend, catalog: new ClaudeModelCatalog() },
  };
  const agentRunExecution = createAgentRunExecutionService({
    workspaceLocks,
    productToolsTokenRegistry,
    runTimeoutMs: config.runTimeoutMs,
    runPort: agentRunPort,
    contextPort,
    ledgerResolver,
    backends,
    idGen: { ulid },
    resolveWorkspace: async ({ conversationId, agentId }) => {
      // Default workspace comes from the Agent record; Loop scopes pin
      // their workspace as a Run fact at enqueue time.
      const agent = agentId ? await agentSvc.getById(agentId).catch(() => null) : null;
      const access =
        agent?.config.runtime_config.permission_mode === "ask" ? "read_only" : "read_write";
      // Project-bound conversation (ADR 0023): cwd is the agent's worktree
      // for that project; context (skills/prompt/token) still comes from
      // the agent workspace. Not attached = explicit dispatch failure.
      const convRow = conv.convPort.getConversation(conversationId);
      if (convRow?.projectId) {
        if (!agent?.config.runtime_config.projects.includes(convRow.projectId)) {
          throw new Error(
            `agent ${agentId ?? "?"} has not attached project ${convRow.projectId}; ` +
              `attach it via the agent update API (agent.yml runtime_config.projects)`,
          );
        }
        const worktree = join(agent.workspacePath, "projects", convRow.projectId);
        return { root: worktree, access };
      }
      return {
        root: agent?.workspacePath ?? config.workspaceRoot,
        access,
      };
    },
    productToolsEntrypoint: config.productToolsMcpUrl
      ? `sse:${config.productToolsMcpUrl.endsWith("/sse") ? config.productToolsMcpUrl : `${config.productToolsMcpUrl}/sse`}`
      : "stdio:/nonexistent",
    onRunCommitted,
    conversationTitleOf: (conversationId: string) =>
      conv.convPort.getConversation(conversationId)?.title ?? null,
    onRunFailed,
    persistRunEvent: (runId, event) => {
      services.opsStore.appendRunEvent(
        runId,
        event.type,
        event as unknown as Record<string, unknown>,
      );
      return Promise.resolve();
    },
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

  const agentNames = new Map<string, string>();
  {
    const rows = await agentSvc.list(true);
    for (const r of rows) agentNames.set(r.id, r.config.name);
  }

  const opsSvc = createRuntimeOpsService({
    opsStore: services.opsStore,
    getAgentName: (agentId: string) => agentNames.get(agentId),
  });

  // ─── Project ────────────────────────────────────────────────

  const projectPort = sqliteProjectAdapter(db);
  const projectSvc = createProjectService({
    port: projectPort,
    hasProjectBinding: (pid: string) => conv.convPort.hasProjectBinding?.(pid) ?? false,
    idGen: ulid,
    // Detach guard (ADR 0023): refuse deleting a project agents still
    // attach to. agentSvc.list returns rows carrying the materialized
    // config cache; includeArchived covers archived agents too.
    listAgentConfigs: async () =>
      (await agentSvc.list(true)).map((a) => ({
        id: a.id,
        projects: a.config.runtime_config.projects,
      })),
  });

  // ─── MCP ────────────────────────────────────────────────────

  const mcpSvcRaw = createMcpService({
    port: fileMcpServerAdapter(config.dataDir),
    mcpClientManager,
    agentExists: (id: string) => agentSvc.exists(id),
    getAgentMcpServers: async (agentId) => {
      const agent = await agentSvc.getById(agentId);
      return agent.config.runtime_config.mcp_servers.map((s) => ({
        serverId: s.server_id,
        enabled: s.enabled,
      }));
    },
    setAgentMcpServers: async (agentId, entries) => {
      await agentSvc.update(agentId, {
        mcpServers: entries.map((e) => ({ serverId: e.serverId, enabled: e.enabled })),
      });
    },
    idGen: ulid,
  });
  // Catalog mutations + assignment changes re-reconcile every affected
  // agent's workspace mcp.json (ADR 0022).
  const mcpSvc: ReturnType<typeof createMcpService> = {
    ...mcpSvcRaw,
    async create(input) {
      const row = await mcpSvcRaw.create(input);
      return row;
    },
    async update(serverId, input) {
      const row = await mcpSvcRaw.update(serverId, input);
      for (const agentId of await agentIdsWithMcpServer(serverId)) {
        await reconcileAgent.fn(agentId);
      }
      return row;
    },
    async delete(serverId) {
      const affected = await agentIdsWithMcpServer(serverId);
      await mcpSvcRaw.delete(serverId);
      for (const agentId of affected) await reconcileAgent.fn(agentId);
    },
    async setAgentServers(agentId, entries) {
      await mcpSvcRaw.setAgentServers(agentId, entries);
      await reconcileAgent.fn(agentId);
    },
  };
  async function agentIdsWithMcpServer(serverId: string): Promise<string[]> {
    // The catalog row exists before delete; agents are whoever assigned it.
    const all = await agentSvc.list();
    const ids: string[] = [];
    for (const agent of all) {
      if ((await mcpSvcRaw.listAssignments(agent.id)).some((a) => a.serverId === serverId)) {
        ids.push(agent.id);
      }
    }
    return ids;
  }

  reconcileAgent.fn = async (agentId: string, prevProjects?: string[]): Promise<void> => {
    try {
      const agent = await agentSvc.getById(agentId);
      // Detach cleanup (ADR 0023): projects removed since the previous
      // config get their worktree + branch removed.
      if (prevProjects) {
        const removed = prevProjects.filter(
          (pid) => !agent.config.runtime_config.projects.includes(pid),
        );
        for (const pid of removed) {
          const project = projectSvc.getById(pid);
          if (!project?.repoUrl) continue;
          try {
            const mirror = await ensureMirror(config.dataDir, {
              projectId: project.projectId,
              repoUrl: project.repoUrl,
              defaultBranch: project.defaultBranch,
            });
            await removeWorktree(
              mirror,
              agent.workspacePath,
              {
                projectId: project.projectId,
                repoUrl: project.repoUrl,
                defaultBranch: project.defaultBranch,
              },
              agentId,
            );
          } catch (err) {
            console.warn(`[reconcile] detach cleanup for ${agentId}/${pid} failed:`, err);
          }
        }
      }
      const packs = await skillPackPort.listForAgent(agentId);
      const assignedKnowledge = agent.config.runtime_config.knowledge_packs
        .map((packId) => knowledgeSvc.getById(packId))
        .filter((p): p is NonNullable<typeof p> => p !== null && p.status === "ready");
      // ADR 0023: materialize a worktree per attached project and bridge
      // the same mcp + product-tools config into it. Failures warn, never
      // throw (reconcile stays best-effort like the other bridges).
      const extraRoots: string[] = [];
      for (const pid of agent.config.runtime_config.projects) {
        const project = projectSvc.getById(pid);
        if (!project?.repoUrl) {
          console.warn(
            `[reconcile] agent ${agentId}: project ${pid} missing or no repoUrl, skipped`,
          );
          continue;
        }
        const wp = {
          projectId: project.projectId,
          repoUrl: project.repoUrl,
          defaultBranch: project.defaultBranch,
        };
        try {
          const mirror = await ensureMirror(config.dataDir, wp);
          const wt = await ensureWorktree(mirror, agent.workspacePath, wp, agentId);
          if (wt) extraRoots.push(wt);
          else {
            console.warn(
              `[reconcile] agent ${agentId}: worktree slot for ${pid} occupied, skipped`,
            );
          }
        } catch (err) {
          console.warn(`[reconcile] agent ${agentId}: worktree for ${pid} failed:`, err);
        }
      }
      reconcileAgentResources({
        extraRoots,
        workspacePath: agent.workspacePath,
        kind: agent.config.runtime_config.runtime,
        skillPacks: packs
          .filter((p) => p.status === "ready")
          .map((p) => ({ id: p.id, source: installPath(config.dataDir, p.id) })),
        mcpServers: [
          ...(await mcpSvc.listForAgent(agentId)).map((s) => ({
            name: s.name,
            transport: s.transport,
            url: s.url,
            command: s.command,
            args: s.args ?? [],
            env: s.env ?? {},
            headers: s.headers ?? {},
          })),
          // The product-tools server (ledger access, ADR 0020) merges into
          // the SAME workspace .mcp.json — one config, one writer.
          ...(config.productToolsMcpUrl
            ? [
                {
                  name: "product-tools",
                  transport: "sse" as const,
                  // The SSE session endpoint is `<base>/sse` (the child's
                  // SSEClientTransport GETs the url as-is; the bare base
                  // 404s). Append only when not already path-suffixed.
                  url: config.productToolsMcpUrl.endsWith("/sse")
                    ? config.productToolsMcpUrl
                    : `${config.productToolsMcpUrl}/sse`,
                  // ENV NAME, not the token: pi (bearerTokenEnv) and omp
                  // (bearer_token_env_var) read this var at connect time;
                  // claude expands the ${VAR} placeholder in headers. The
                  // per-run bearer arrives via spawn env. File stays static.
                  bearerTokenEnv: "PRODUCT_TOOLS_RUN_TOKEN",
                },
              ]
            : []),
          // The knowledge recall server (ADR 0022): merged only when the
          // agent has ready packs (stdio, scoped to its knowledge dir).
          ...(assignedKnowledge.length > 0
            ? [
                {
                  name: "knowledge",
                  transport: "stdio" as const,
                  command: process.execPath,
                  args: [
                    resolveKnowledgeMcpServerEntry(config),
                    join(agent.workspacePath, "knowledge"),
                    ...assignedKnowledge.flatMap((p) =>
                      p.installedRef ? ["--allowed-pack", p.installedRef] : [],
                    ),
                  ],
                },
              ]
            : []),
        ],
        productTools: config.productToolsMcpUrl
          ? [
              ...buildHistoryTools(
                `sse:${config.productToolsMcpUrl.endsWith("/sse") ? config.productToolsMcpUrl : `${config.productToolsMcpUrl}/sse`}`,
              ),
            ]
          : [],
        knowledgePacks: assignedKnowledge.map((p) => ({
          id: p.id,
          source: p.installedRef ?? "",
          name: p.name,
          description: p.description,
        })),
      });
    } catch (err) {
      console.error(`[bridge] reconcile failed for ${agentId}:`, err);
    }
  };

  // ─── Knowledge packs (ADR 0022) ──────────────────────────────
  const knowledgeSvc = createKnowledgeService({
    port: sqliteKnowledgePackAdapter(db),
    dataDir: config.dataDir,
    idGen: ulid,
    builtinRoot: resolve(import.meta.dir, "../../../../knowledge-packs"),
  });

  // Builtin project knowledge pack: installed once, then available to every agent.
  if (!knowledgeSvc.list().some((p) => p.sourceKind === "builtin" && p.name === "my-agent-team")) {
    await knowledgeSvc
      .install({
        name: "my-agent-team",
        description: "my-agent-team project knowledge: architecture, conventions, ADRs, operations",
        sourceKind: "builtin",
      })
      .catch((err: Error) =>
        console.error(`[knowledge] builtin my-agent-team seed failed: ${err.message}`),
      );
  }

  // ─── FeatureSet ─────────────────────────────────────────────

  // Worktree read/merge ops over the project mirrors (ADR 0023 P2).
  const worktreeOps = createWorktreeOps({
    dataDir: config.dataDir,
    projectPort,
    listAgentConfigs: async () =>
      (await agentSvc.list(true)).map((a) => ({
        id: a.id,
        workspacePath: a.workspacePath,
        projects: a.config.runtime_config.projects,
      })),
  });

  // ─── Agentic Workflow ───────────────────────────────────
  const workflowPort = sqliteWorkflowExecutionAdapter(db);
  const workflowEventBus = new ExecutionEventBus();
  const workflowNodeRunners = createNodeRunners({
    dataDir: config.dataDir,
    onLog: (executionId, data) =>
      workflowEventBus.emit({ event: "script_log", executionId, ts: Date.now(), data }),
  });
  const workflowExecutionService = createWorkflowExecutionService({
    port: workflowPort,
    nodeRunners: workflowNodeRunners,
    eventBus: workflowEventBus,
    idGen: ulid,
    agentRunService,
    agentRunExecution,
    convPort,
    conversationService: conv.convSvc,
    artifactService,
    resolveDefaultModel: async (agentId) => agentModelRef(await agentSvc.getById(agentId)),
    resolveRepoWorkspace: async (repo) => ({
      root: join(config.dataDir, "projects", repo),
      access: "read_write",
    }),
  });
  // Builtin showcase: seed the default workflow into dataDir/workflows when
  // the user has none yet (first boot / empty install).
  {
    const wfDir = join(config.dataDir, "workflows");
    mkdirSync(wfDir, { recursive: true });
    const existing = readdirSync(wfDir).filter((f) => f.endsWith(".workflow.json"));
    if (existing.length === 0) {
      const showcaseDir = join(import.meta.dir, "..", "features", "workflow", "showcase");
      for (const f of readdirSync(showcaseDir)) {
        if (f.endsWith(".workflow.json")) {
          copyFileSync(join(showcaseDir, f), join(wfDir, f));
          console.log(`[bootstrap] seeded showcase workflow: ${f}`);
        }
      }
    }
  }

  // Builtin showcase workflows: seed skill-generated samples into
  // dataDir/workflows on first boot (empty dir only).
  {
    const wfDir = join(config.dataDir, "workflows");
    mkdirSync(wfDir, { recursive: true });
    const existing = readdirSync(wfDir).filter((f) => f.endsWith(".workflow.json"));
    if (existing.length === 0) {
      const showcaseDir = join(import.meta.dir, "features", "workflow", "showcase");
      for (const f of readdirSync(showcaseDir)) {
        if (f.endsWith(".workflow.json")) copyFileSync(join(showcaseDir, f), join(wfDir, f));
      }
    }
  }

  const workflowTriggerScheduler = createWorkflowTriggerScheduler({
    workflowDir: join(config.dataDir, "workflows"),
    schedule: (expr: string, fn: () => void) => {
      const h = Bun.cron(expr, fn);
      return { stop: () => h.stop() };
    },
    startExecution: (input: {
      workflowId: string;
      definition: WorkflowDefinition;
      input: Record<string, unknown>;
    }) => workflowExecutionService.startExecution(input),
  });

  const workflowApp = workflowRoutes({
    workflowExecutionService,
    loadWorkflow: async (ref) => {
      const file = join(config.dataDir, "workflows", ref.path);
      return await Bun.file(file).text();
    },
    workflowDir: join(config.dataDir, "workflows"),
    resyncTriggers: () => workflowTriggerScheduler.sync(),
  });

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
        setAgentPacks: async (id: string, packIds: string[]) => {
          await skillPackSvc.setAgentPacks(id, packIds);
          await reconcileAgent.fn(id);
        },
      },
      identityStore,
      (id: string) => larkBotRegistry.statusOf(id),
      getSetupManager,
      (id: string) => projectSvc.exists(id),
    ),
    conversations: conversationRoutes(conv.convSvc, ulid, conv.goalStore, (id: string) =>
      projectSvc.exists(id),
    ),
    ops: opsRoutes(opsSvc),
    agentRuns: agentRunRoutes({
      db,
      agentRunService,
      agentRunExecution,
      // ponytail: catalog prices snapshotted once per boot; catalogs are
      // static for the process lifetime (env/config driven).
      modelCosts: (async () => {
        const map = new Map<
          string,
          { input: number; output: number; cacheRead: number; cacheWrite: number }
        >();
        for (const [kind, entry] of Object.entries(backends)) {
          for (const m of (await entry.catalog.list()).models) {
            map.set(`${kind}/${resolveModelAlias(m.id)}`, m.cost);
          }
        }
        return map;
      })(),
    }),
    projects: projectRoutes(projectSvc, worktreeOps),
    skillPacks: skillPackRoutes(skillPackSvc, config.dataDir),
    mcp: mcpRoutes(mcpSvc),
    knowledge: knowledgeRoutes(knowledgeSvc),
    workflowExecutions: workflowApp,
    artifacts: artifactRoutes(artifactService),
    settings: settingsRoutes(settingsSvc),

    models: modelRoutes({
      list: async () => {
        // Aggregate every registered backend's catalog, tagging each model
        // with its kind. Each returns composite `<provider>/<model>` ids;
        // grouping and prefix-stripping happen once in
        // modelRoutes.groupByProvider. WebModel carries backendKind so the
        // UI can group by kind first (D3).
        const lists = await Promise.all(
          (Object.entries(backends) as Array<[BackendKind, BackendRegistryEntry]>).map(
            async ([kind, entry]) =>
              (await entry.catalog.list()).models.map((m) => ({ ...m, backendKind: kind })),
          ),
        );
        return lists.flat().map((m) => ({
          id: m.id,
          name: m.displayName ?? m.id,
          available: m.available,
          reasoning: m.reasoning,
          input: m.inputModalities,
          cost: m.cost,
          contextWindow: m.contextWindow,
          maxTokens: m.maxOutputTokens,
          backendKind: m.backendKind,
        }));
      },
    }),
  };

  // ─── Lifecycle ──────────────────────────────────────────────

  // Self-smoke cron (docs/insights.md I4): when SMOKE_CRON is set, spawn
  // the workflow smoke as a separate process on schedule. A workflow
  // script-node cannot host this - the smoke boots a second in-process
  // backend, which would be circular inside a product execution.
  let smokeCron: { stop(): unknown } | undefined;

  async function start(): Promise<void> {
    await workflowTriggerScheduler.sync();
    await workflowExecutionService.recover();
    const smokeCronExpr = process.env.SMOKE_CRON;
    if (smokeCronExpr) {
      smokeCron = Bun.cron(smokeCronExpr, () => {
        void (async () => {
          const smokeEntry = join(import.meta.dir, "../../../../scripts/smoke-workflow.ts");
          console.log(`[smoke] workflow smoke start ${new Date().toISOString()}`);
          const proc = Bun.spawn([process.execPath, smokeEntry], {
            stdout: "inherit",
            stderr: "inherit",
          });
          const code = await proc.exited;
          console.log(`[smoke] workflow smoke exit=${code}`);
        })();
      });
      console.log(`[smoke] workflow smoke scheduled: ${smokeCronExpr}`);
    }
  }

  async function dispose(): Promise<void> {
    // Order matters: stop producing Runs first, then kill every Coding
    // Agent child and drain in-flight dispatches (the DB must not close
    // mid-finalize), THEN close surfaces that children may still call
    // (Product Tools MCP) and finally Lark/setup.
    smokeCron?.stop();
    await agentRunExecution.dispose(); // abort/SIGTERM/SIGKILL children + drain
    await workflowTriggerScheduler.dispose();
    await workflowExecutionService.dispose();
    await larkBotRegistry.dispose();
    setupManager?.dispose();
    await productToolsMcp?.close();
  }

  // Seed the default agent AFTER the whole wiring (the catalog const and
  // the reconcile binding): an early call reads a TDZ const and skips the
  // workspace reconcile (no skills links, no .mcp.json).
  {
    const seedModel = await defaultSeedModel();
    await ensureAgent("default", "Assistant", seedModel);
  }

  // B4: one best-effort reconcile over every agent at boot — worktrees and
  // bridged configs refresh without waiting for the first PATCH (replaces
  // any stale static-bearer .mcp.json from older installs). Failures warn
  // per agent; startup proceeds.
  for (const agent of await agentSvc.list(true)) {
    try {
      await reconcileAgent.fn(agent.id);
    } catch (err) {
      console.warn(`[bootstrap] startup reconcile failed for ${agent.id}:`, err);
    }
  }

  return {
    featureSet,
    agentRunService,
    agentRunExecution,
    productTools,
    workflowExecutionService,
    start,
    dispose,
  };
}
