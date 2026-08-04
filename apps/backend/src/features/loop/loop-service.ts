import { mkdir, rm } from "node:fs/promises";
import type { BackendModelRef } from "@my-agent-team/agent-backend";
import type { ItemState, LoopState, Verdict } from "@my-agent-team/loop";
import type { AgentRunExecutionService } from "../agent-run/execution.js";
import type { AgentRunService } from "../agent-run/service.js";
import type { ConversationPort } from "../conversation/ports.js";
import type { CronJobService } from "../cron/service.js";
import { loopStep } from "../loop/loop-step.js";
import { resolveLoopPaths } from "../loop/resolve-paths.js";
import type { ProjectPort } from "../project/ports.js";
import type { SettingsService } from "../settings/index.js";
import type { LoopStateStore } from "./loop-state-store.js";

// ── Result types ───────────────────────────────────────────────────────────

export interface LoopListItem {
  cronJobId: string;
  name: string;
  agentId: string;
  cronExpr: string;
  enabled: boolean;
  loopConfigPath: string | null;
  state: string;
  lastRun: string | null;
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
  generatorRunId?: string;
  evaluatorRunId?: string;
}

export interface LoopDetail {
  id: string;
  name: string;
  cronExpr: string;
  enabled: boolean;
  loopConfigPath: string;
  items: LoopDetailItem[];
  lastRun: string | null;
  state: LoopState;
  pendingCount: number;
  budgetHistory: Array<{ date: string; spent: number }>;
}

export type CreateLoopResult = {
  status: "generated";
  loop: {
    id: string;
    name: string;
    cronExpr: string;
    loopConfigPath: string | null;
    preview: string;
  };
};

export type RefineLoopResult = {
  status: "generated";
  loop: {
    id: string;
    name: string;
    cronExpr: string;
    loopConfigPath: string | null;
    preview: string;
  };
};

// ── Query functions ────────────────────────────────────────────────────────

export function listLoops(cronSvc: CronJobService, store: LoopStateStore): LoopListItem[] {
  return cronSvc.port.listCronJobs().map((job) => {
    const state = job.loopConfigPath ? store.load(job.cronJobId) : null;
    return {
      cronJobId: job.cronJobId,
      name: job.name,
      agentId: job.agentId,
      cronExpr: job.cronExpr,
      enabled: job.enabled,
      loopConfigPath: job.loopConfigPath ?? null,
      state: job.loopConfigPath ? (state?.items ? "active" : "empty") : "not_loop",
      lastRun: state?.lastRun ?? null,
      pendingCount: state
        ? Object.values(state.items).filter((i) => i.step === "awaiting_review").length
        : 0,
    };
  });
}

export function getTodayWork(cronSvc: CronJobService, store: LoopStateStore): ReviewQueueItem[] {
  const out: ReviewQueueItem[] = [];
  for (const job of cronSvc.port.listCronJobs()) {
    if (!job.loopConfigPath || !job.enabled) continue;
    const state = store.load(job.cronJobId);
    for (const item of Object.values(state.items)) {
      if (item.step === "awaiting_review") {
        out.push({ ...item, loopId: job.cronJobId, loopName: job.name });
      }
    }
  }
  return out;
}

export function getLoopDetail(
  cronSvc: CronJobService,
  store: LoopStateStore,
  id: string,
): LoopDetail | null {
  const job = cronSvc.getById(id);
  if (!job?.loopConfigPath) return null;
  const state = store.load(id);
  const items: LoopDetailItem[] = Object.entries(state.items).map(([itemId, item]) => ({
    id: itemId,
    source: item.source,
    summary: item.summary,
    step: item.step,
    attempt: item.attempt,
    priority: item.priority,
    result: item.result,
    generatorRunId: item.generatorSpanId,
    evaluatorRunId: item.evaluatorRunId,
  }));
  return {
    id,
    name: job.name,
    cronExpr: job.cronExpr,
    enabled: job.enabled,
    loopConfigPath: job.loopConfigPath,
    items,
    lastRun: state.lastRun,
    state,
    pendingCount: items.filter((i) => i.step === "awaiting_review").length,
    budgetHistory: store.getBudgetHistory(id, 7),
  };
}

// ── Create loop ────────────────────────────────────────────────────────────

export interface CreateLoopInput {
  name: string;
  intent?: string;
  projectId?: string;
  cronExpr?: string;
}

/** Loop configuration is deterministic: create the directory, write the
 *  default LOOP.md template, copy fixed skill templates, set cron config.
 *  No Agent, no Context Branch, no update_loop_config Product Tool. */
export async function createLoop(
  deps: {
    cronSvc: CronJobService;
    dataDir: string;
    convPort?: ConversationPort;
    settingsSvc?: SettingsService;
  },
  input: CreateLoopInput,
): Promise<CreateLoopResult> {
  const { cronSvc, dataDir, convPort, settingsSvc } = deps;

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

  // 2. Create Conversation (audit container, best-effort)
  try {
    convPort?.createConversation({
      conversationId: job.cronJobId,
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

  // 3. Create directory + copy runtime skill templates
  await mkdir(`${dir}/skills`, { recursive: true });
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

  // 4. Deterministic LOOP.md (intent is documented, not interpreted)
  await writeDefaultLoopMd(dir, input.name, input.projectId, settingsSvc);

  return readGenerationResult(dir, job.cronJobId, job.name, job.cronExpr, job.loopConfigPath);
}

// ── Refine loop ────────────────────────────────────────────────────────────

export interface RefineLoopInput {
  intent: string;
}

/** Refinement regenerates the deterministic default template (AI-based
 *  natural-language config generation is YAGNI for Phase 5). */
export async function refineLoop(
  deps: {
    cronSvc: CronJobService;
    dataDir: string;
    settingsSvc?: SettingsService;
  },
  id: string,
  _input: RefineLoopInput,
): Promise<RefineLoopResult | null> {
  const { cronSvc, dataDir, settingsSvc } = deps;
  const job = cronSvc.getById(id);
  if (!job?.loopConfigPath) return null;
  const dir = `${dataDir}/${job.loopConfigPath}`;

  await safeRm(`${dir}/LOOP.md`);
  await writeDefaultLoopMd(dir, job.name, undefined, settingsSvc);

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
    projectPort?: ProjectPort;
    store: LoopStateStore;
    convPort: ConversationPort;
    agentRunService: AgentRunService;
    agentRunExecution: AgentRunExecutionService;
    resolveModel: (modelName: string) => Promise<BackendModelRef>;
  },
  id: string,
): Promise<LoopState | null> {
  const {
    cronSvc,
    dataDir,
    projectPort,
    store,
    convPort,
    agentRunService,
    agentRunExecution,
    resolveModel,
  } = deps;
  const job = cronSvc.getById(id);
  if (!job?.loopConfigPath) return null;

  return loopStep({
    loopConfigPath: resolveLoopPaths(job, dataDir).loopConfigPath,
    projectPort,
    dataDir,
    store,
    loopId: job.cronJobId,
    convPort,
    agentRunService,
    agentRunExecution,
    resolveModel,
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
    projectPort?: ProjectPort;
    store: LoopStateStore;
    convPort: ConversationPort;
    agentRunService: AgentRunService;
    agentRunExecution: AgentRunExecutionService;
    resolveModel: (modelName: string) => Promise<BackendModelRef>;
  },
  id: string,
  input: ReviewInput,
): Promise<{ state: LoopState; action: string } | null> {
  const {
    cronSvc,
    dataDir,
    projectPort,
    store,
    convPort,
    agentRunService,
    agentRunExecution,
    resolveModel,
  } = deps;
  const job = cronSvc.getById(id);
  if (!job?.loopConfigPath) return null;

  const state = await loopStep({
    loopConfigPath: resolveLoopPaths(job, dataDir).loopConfigPath,
    projectPort,
    dataDir,
    action: {
      itemId: input.itemId,
      verdict: input.verdict,
      feedback: input.feedback,
    },
    store,
    loopId: job.cronJobId,
    convPort,
    agentRunService,
    agentRunExecution,
    resolveModel,
  });

  return { state, action: input.verdict };
}

// ── Internal helpers ───────────────────────────────────────────────────────

const RUNTIME_SKILLS = ["loop-triage", "loop-generator", "loop-verifier"] as const;

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
  let preview = "";
  try {
    preview = await Bun.file(`${dir}/LOOP.md`).text();
  } catch {
    // LOOP.md may not exist yet - preview stays empty
  }

  return {
    status: "generated",
    loop: { id: loopId, name, cronExpr, loopConfigPath: loopConfigPath ?? null, preview },
  };
}

async function safeRm(path: string): Promise<void> {
  try {
    await rm(path);
  } catch {
    // file may not exist - ignore
  }
}
