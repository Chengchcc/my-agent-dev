import { mkdir, rm } from "node:fs/promises";
import { createAgentSession, type AgentConfig as SessionConfig, type SessionManager } from "@my-agent-team/agent";
import type { ItemState, LoopState, Verdict } from "@my-agent-team/loop";
import type { AppendLedgerInput } from "../conversation/ports.js";
import type { CronJobPort } from "../cron/ports.js";
import type { CronScheduler } from "../cron/scheduler.js";
import type { CronJobService } from "../cron/service.js";
import { loopStep } from "../loop/loop-step.js";
import { resolveLoopPaths } from "../loop/resolve-paths.js";
import type { ProjectPort } from "../project/ports.js";
import type { SettingsService } from "../settings/index.js";
import { nodeFsAdapter } from "../skill-pack/fs-adapter.js";
import type { SkillRoots } from "../span/skill-roots.js";
import type { LoopStateStore } from "./loop-state-store.js";
import { createUpdateLoopConfigTool } from "./tools.js";

// ── Shared dependency types ────────────────────────────────────────────────

export interface ConvPort {
  createConversation: (input: {
    conversationId: string;
    title?: string;
    origin?: string;
    createdAt: number;
  }) => unknown;
  addMember: (input: {
    conversationId: string;
    memberId: string;
    kind: "agent" | "human";
    agentId?: string;
    joinedAt: number;
  }) => unknown;
  appendLedgerEntry: (input: AppendLedgerInput) => unknown;
}

export type BuildConfigFn = (params: {
  modelName: string;
  cwd: string;
  skillRoots?: SkillRoots;
}) => SessionConfig;

// ── Result types ───────────────────────────────────────────────────────────

export interface LoopListItem {
  cronJobId: string;
  name: string;
  agentId: string;
  cronExpr: string;
  prompt: string;
  enabled: boolean;
  timeoutMs: number;
  maxRetries: number;
  loopConfigPath?: string | null;
  createdAt: number;
  updatedAt: number;
  pendingCount: number;
}

export interface ReviewQueueItem extends ItemState {
  loopId: string;
  loopName: string;
}

export interface LoopDetailItem {
  id: string;
  source: string;
  summary: string;
  step: ItemState["step"];
  attempt: number;
  priority: number;
  result: Verdict | null;
  generatorSpanId: string | null;
}

export interface LoopDetail {
  id: string;
  name: string;
  cronExpr: string;
  enabled: boolean;
  loopConfigPath?: string | null;
  lastRun: string | null;
  pendingCount: number;
  items: LoopDetailItem[];
  budgetHistory: Array<{ date: string; spent: number }>;
}

export type CreateLoopResult =
  | { status: "needs_clarification"; loopId: string; questions: string[] }
  | {
      status: "generated";
      loop: {
        id: string;
        name: string;
        cronExpr: string;
        loopConfigPath?: string | null;
        preview: string;
      };
    };

export type RefineLoopResult =
  | { status: "needs_clarification"; loopId: string; questions: string[] }
  | {
      status: "generated";
      loop: {
        id: string;
        name: string;
        cronExpr: string;
        loopConfigPath?: string | null;
        preview: string;
      };
      note?: string;
    };

// ── Query functions ────────────────────────────────────────────────────────

export function listLoops(cronSvc: CronJobService, store: LoopStateStore): LoopListItem[] {
  return cronSvc
    .list()
    .filter((j) => j.loopConfigPath != null)
    .map((j) => ({
      ...j,
      pendingCount: Object.values(store.load(j.cronJobId).items).filter(
        (i) => i.step === "awaiting_review",
      ).length,
    }));
}

export function getTodayWork(cronSvc: CronJobService, store: LoopStateStore): ReviewQueueItem[] {
  const loops = cronSvc.list().filter((j) => j.loopConfigPath != null);
  const reviewQueue: ReviewQueueItem[] = [];
  for (const loop of loops) {
    const state = store.load(loop.cronJobId);
    for (const item of Object.values(state.items)) {
      if (item.step === "awaiting_review") {
        reviewQueue.push({ ...item, loopId: loop.cronJobId, loopName: loop.name });
      }
    }
  }
  return reviewQueue;
}

export function getLoopDetail(
  cronSvc: CronJobService,
  store: LoopStateStore,
  id: string,
): LoopDetail | null {
  const job = cronSvc.getById(id);
  if (!job?.loopConfigPath) return null;

  const state = store.load(id);
  const items: LoopDetailItem[] = Object.values(state.items).map((i) => ({
    id: i.id,
    source: i.source,
    summary: i.summary,
    step: i.step,
    attempt: i.attempt,
    priority: i.priority,
    result: i.result ?? null,
    generatorSpanId: i.generatorSpanId ?? null,
  }));
  const pendingCount = items.filter((i) => i.step === "awaiting_review").length;

  return {
    id: job.cronJobId,
    name: job.name,
    cronExpr: job.cronExpr,
    enabled: job.enabled,
    loopConfigPath: job.loopConfigPath,
    lastRun: state.lastRun,
    pendingCount,
    items,
    budgetHistory: store.getBudgetHistory(id),
  };
}

// ── Create loop ────────────────────────────────────────────────────────────

const RUNTIME_SKILLS = ["loop-triage", "loop-generator", "loop-verifier"] as const;

export interface CreateLoopInput {
  name: string;
  intent?: string;
  projectId?: string;
  cronExpr?: string;
}

export async function createLoop(
  deps: {
    cronSvc: CronJobService;
    cronPort: CronJobPort;
    scheduler: CronScheduler;
    dataDir: string;
    sessionManager: SessionManager;
    buildConfig: BuildConfigFn;
    convPort?: ConvPort;
    settingsSvc?: SettingsService;
  },
  input: CreateLoopInput,
): Promise<CreateLoopResult> {
  const {
    cronSvc,
    cronPort,
    scheduler,
    dataDir,
    sessionManager,
    buildConfig,
    convPort,
    settingsSvc,
  } = deps;

  const loopName = input.name.trim().toLowerCase().replace(/\s+/g, "-");
  const loopPath = `loops/${loopName}`;
  const dir = `${dataDir}/${loopPath}`;

  // 1. Create cron_job row
  const job = await cronSvc.createCronJob({
    name: input.name,
    agentId: "loop-agent",
    cronExpr: input.cronExpr ?? "",
    prompt: input.intent || "",
    loopConfigPath: loopPath,
    enabled: false,
  });

  // 2. Create Conversation (best-effort)
  try {
    convPort?.createConversation({
      conversationId: job.cronJobId,
      title: input.name,
      origin: "loop",
      createdAt: Date.now(),
    });
    convPort?.addMember({
      conversationId: job.cronJobId,
      memberId: "owner",
      kind: "agent",
      agentId: "loop-agent",
      joinedAt: Date.now(),
    });
  } catch {
    // best-effort
  }

  // 3. Create directory
  await mkdir(`${dir}/skills`, { recursive: true });

  // 4. Copy runtime skill templates
  for (const skill of RUNTIME_SKILLS) {
    const src = `${dataDir}/skill-packs/loop-engine/${skill}/SKILL.md`;
    const dst = `${dir}/skills/${skill}/SKILL.md`;
    try {
      await mkdir(`${dir}/skills/${skill}`, { recursive: true });
      await Bun.write(dst, await Bun.file(src).text());
    } catch {
      // template unavailable
    }
  }

  // 5. If intent provided, run AgentSession to generate LOOP.md
  if (input.intent) {
    await runLoopConfigGeneration({
      dir,
      dataDir,
      cronJobId: job.cronJobId,
      intent: input.intent,
      sessionManager,
      buildConfig,
      cronPort,
      scheduler,
    });
  } else {
    await writeDefaultLoopMd(dir, input.name, input.projectId, settingsSvc);
  }

  // 6. Check for clarification request first
  return readGenerationResult(dir, job.cronJobId, job.name, job.cronExpr, job.loopConfigPath);
}

// ── Refine loop ────────────────────────────────────────────────────────────

export interface RefineLoopInput {
  intent: string;
  clarifyRound?: number;
}

export async function refineLoop(
  deps: {
    cronSvc: CronJobService;
    cronPort: CronJobPort;
    scheduler: CronScheduler;
    dataDir: string;
    sessionManager: SessionManager;
    buildConfig: BuildConfigFn;
  },
  id: string,
  input: RefineLoopInput,
): Promise<RefineLoopResult | null> {
  const { cronSvc, cronPort, scheduler, dataDir, sessionManager, buildConfig } = deps;

  const job = cronSvc.getById(id);
  if (!job?.loopConfigPath) return null;
  const dir = `${dataDir}/${job.loopConfigPath}`;

  // Clean old artifacts
  await safeRm(`${dir}/.clarify.json`);
  await safeRm(`${dir}/LOOP.md`);

  // Re-run generation with refined intent
  await runLoopConfigGeneration({
    dir,
    dataDir,
    cronJobId: job.cronJobId,
    intent: input.intent,
    sessionManager,
    buildConfig,
    cronPort,
    scheduler,
  });

  const round = input.clarifyRound ?? 0;

  // Check results
  let clarifyContent: string | null = null;
  try {
    clarifyContent = await Bun.file(`${dir}/.clarify.json`).text();
  } catch {
    // file may not exist - ignore
  }

  if (clarifyContent) {
    // Clarification round gate: at round >= 2, stop asking and emit an
    // empty template so the user can finish it by hand.
    if (round >= 2) {
      await safeRm(`${dir}/.clarify.json`);
      const preview = [
        "---",
        `projectId: `,
        "generator:",
        "  model: claude-sonnet-4",
        '  systemPrompt: ""',
        "evaluator:",
        "  model: claude-opus-4",
        '  systemPrompt: ""',
        'acceptance: ""',
        "---",
        "",
        `# ${job.name}`,
      ].join("\n");
      await Bun.write(`${dir}/LOOP.md`, preview);
      return {
        status: "generated",
        loop: {
          id,
          name: job.name,
          cronExpr: job.cronExpr,
          loopConfigPath: job.loopConfigPath,
          preview,
        },
        note: "已达澄清上限，已生成空模板，请手动编辑",
      };
    }
    const clarify = JSON.parse(clarifyContent) as { questions: string[] };
    return {
      status: "needs_clarification",
      loopId: id,
      questions: clarify.questions,
    };
  }

  let preview = "";
  try {
    preview = await Bun.file(`${dir}/LOOP.md`).text();
  } catch {
    // file may not exist - ignore
  }

  return {
    status: "generated",
    loop: {
      id,
      name: job.name,
      cronExpr: job.cronExpr,
      loopConfigPath: job.loopConfigPath,
      preview,
    },
  };
}

// ── Run / Review ───────────────────────────────────────────────────────────

export async function runLoop(
  deps: {
    cronSvc: CronJobService;
    dataDir: string;
    sessionManager: SessionManager;
    buildConfig: BuildConfigFn;
    projectPort?: ProjectPort;
    store: LoopStateStore;
    convPort?: ConvPort;
  },
  id: string,
): Promise<LoopState | null> {
  const { cronSvc, dataDir, sessionManager, buildConfig, projectPort, store, convPort } = deps;
  const job = cronSvc.getById(id);
  if (!job?.loopConfigPath) return null;

  return loopStep({
    loopConfigPath: resolveLoopPaths(job, dataDir).loopConfigPath,
    sessionManager,
    buildConfig,
    projectPort,
    dataDir,
    store,
    loopId: job.cronJobId,
    convPort,
  });
}

export interface ReviewInput {
  itemId: string;
  verdict: "approve" | "reject" | "promote" | "retry" | "dismiss";
  feedback?: string;
}

export async function reviewLoop(
  deps: {
    cronSvc: CronJobService;
    dataDir: string;
    sessionManager: SessionManager;
    buildConfig: BuildConfigFn;
    projectPort?: ProjectPort;
    store: LoopStateStore;
  },
  id: string,
  input: ReviewInput,
): Promise<{ state: LoopState; action: string } | null> {
  const { cronSvc, dataDir, sessionManager, buildConfig, projectPort, store } = deps;
  const job = cronSvc.getById(id);
  if (!job?.loopConfigPath) return null;

  const state = await loopStep({
    loopConfigPath: resolveLoopPaths(job, dataDir).loopConfigPath,
    sessionManager,
    buildConfig,
    projectPort,
    dataDir,
    action: {
      itemId: input.itemId,
      verdict: input.verdict,
      feedback: input.feedback,
    },
    store,
    loopId: job.cronJobId,
  });

  return { state, action: input.verdict };
}

// ── Internal helpers ───────────────────────────────────────────────────────

async function runLoopConfigGeneration(params: {
  dir: string;
  dataDir: string;
  cronJobId: string;
  intent: string;
  sessionManager: SessionManager;
  buildConfig: BuildConfigFn;
  cronPort: CronJobPort;
  scheduler: CronScheduler;
}): Promise<void> {
  const { dir, dataDir, cronJobId, intent, sessionManager, buildConfig, cronPort, scheduler } =
    params;

  const config = buildConfig({
    modelName: "claude-sonnet-4",
    cwd: dir,
    skillRoots: {
      ws: nodeFsAdapter(`${dir}/skills`),
      roots: ["loop-config-generator"],
      posixSkillRoot: `${dir}/skills`,
    },
  });

  // Inject update_loop_config tool so the agent can set the schedule
  const loopConfigTool = createUpdateLoopConfigTool(cronJobId, cronPort, scheduler);
  config.tools = [...(config.tools ?? []), loopConfigTool];

  const registryPath = `${dataDir}/skill-packs/loop-engine/registry.yaml`;
  const prompt = `Create a Loop configuration based on this intent: "${intent}"

Target directory: ${dir}
Registry is at: ${registryPath}

Steps:
1. Use the write tool to create ${dir}/LOOP.md with the appropriate frontmatter
2. Use the write tool to copy skill templates from ${dataDir}/skill-packs/loop-engine/ to ${dir}/skills/
3. If the loop has a schedule, use the update_loop_config tool to set the cron expression`;

  const session = await createAgentSession({ ...config, sessionManager });
  await session.prompt(prompt);
  sessionManager.dispose(session.sessionId ?? "");
}

async function writeDefaultLoopMd(
  dir: string,
  name: string,
  projectId: string | undefined,
  settingsSvc?: SettingsService,
): Promise<void> {
  const genModel = settingsSvc?.get<string>("loop.generatorModel") ?? "claude-sonnet-4";
  const evalModel = settingsSvc?.get<string>("loop.evaluatorModel") ?? "claude-opus-4";
  const acceptance = settingsSvc?.get<string>("loop.defaultAcceptance") ?? "";
  const dailyCap = settingsSvc?.get<number>("loop.defaultDailyCap") ?? 200000;
  const denylist = settingsSvc?.get<string[]>("loop.defaultDenylist") ?? [
    ".env",
    "auth/",
    "payments/",
    "secrets/",
  ];

  const denylistYaml = denylist.map((d) => `        - ${d}`).join("\n");
  await Bun.write(
    `${dir}/LOOP.md`,
    [
      "---",
      `projectId: ${projectId ?? ""}`,
      "generator:",
      `  model: ${genModel}`,
      '  systemPrompt: ""',
      "evaluator:",
      `  model: ${evalModel}`,
      '  systemPrompt: ""',
      `acceptance: "${acceptance}"`,
      "safety:",
      "  denylist:",
      denylistYaml,
      "  maxRetries: 3",
      "  autoMerge: never",
      "budget:",
      `  dailyCap: ${dailyCap}`,
      "---",
      "",
      `# ${name}`,
    ].join("\n"),
  );
}

async function readGenerationResult(
  dir: string,
  loopId: string,
  name: string,
  cronExpr: string,
  loopConfigPath: string | null | undefined,
): Promise<CreateLoopResult> {
  let clarifyContent: string | null = null;
  try {
    clarifyContent = await Bun.file(`${dir}/.clarify.json`).text();
  } catch {
    // No clarify file - check LOOP.md
  }

  if (clarifyContent) {
    const clarify = JSON.parse(clarifyContent) as { questions: string[] };
    return {
      status: "needs_clarification",
      loopId,
      questions: clarify.questions,
    };
  }

  let preview = "";
  try {
    preview = await Bun.file(`${dir}/LOOP.md`).text();
  } catch {
    // LOOP.md may not exist yet - preview stays empty
  }

  return {
    status: "generated",
    loop: { id: loopId, name, cronExpr, loopConfigPath, preview },
  };
}

async function safeRm(path: string): Promise<void> {
  try {
    await rm(path);
  } catch {
    // file may not exist - ignore
  }
}
