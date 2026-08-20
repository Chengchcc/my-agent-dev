import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import type { BackendModelRef } from "@chengchenccc/agent-backend";
import { type ItemState, type LoopState, parseLoopConfig, type Verdict } from "@chengchenccc/loop";
import type { AgentRunExecutionService } from "../agent-run/execution.js";
import type { AgentRunService } from "../agent-run/service.js";
import type { ConversationPort } from "../conversation/ports.js";
import type { CronJobService } from "../cron/service.js";
import { loopStep } from "../loop/loop-step.js";
import type { ProjectPort } from "../project/ports.js";
import type { SettingsService } from "../settings/index.js";
import type { LoopStateStore } from "./loop-state-store.js";
import { resolveLoopPaths } from "./resolve-paths.js";

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
  /** Parsed LOOP.md config for the detail config card. */
  config: {
    model: string;
    acceptance: string;
    fixPrompt: string;
    verifyPrompt: string;
    verifyCommands: string[];
  } | null;
}

export type CreateLoopResult =
  | {
      status: "generated";
      loop: {
        id: string;
        name: string;
        cronExpr: string;
        loopConfigPath: string | null;
        preview: string;
      };
    }
  | { status: "needs_clarification"; questions: string[] };

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

/** Minimal LOOP.md frontmatter read for list views: projectId + agent. */
function readLoopProjectId(loopConfigPath: string): string | null {
  try {
    const text = readFileSync(`${loopConfigPath}/LOOP.md`, "utf-8");
    const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m?.[1]) return null;
    const pid = m[1].match(/^projectId:\s*(.+)$/m);
    return pid?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

export function listLoops(
  cronSvc: CronJobService,
  store: LoopStateStore,
  dataDir = ".",
): LoopListItem[] {
  return cronSvc.port.listCronJobs().map((job) => {
    const state = job.loopConfigPath ? store.load(job.cronJobId) : null;
    return {
      cronJobId: job.cronJobId,
      name: job.name,
      agentId: job.agentId,
      // Project binding from LOOP.md frontmatter (read once per list; the
      // file parse is cheap and cached by the OS).
      projectId: job.loopConfigPath
        ? readLoopProjectId(resolveLoopPaths(job, dataDir).loopConfigPath)
        : null,
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
  dataDir?: string,
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
    generatorRunId: item.generatorRunId,
    evaluatorRunId: item.evaluatorRunId,
  }));
  let config: LoopDetail["config"] = null;
  if (dataDir) {
    try {
      const md = readFileSync(`${resolveLoopPaths(job, dataDir).loopConfigPath}/LOOP.md`, "utf-8");
      const parsed = parseLoopConfig(md);
      if (parsed) {
        config = {
          model: parsed.model,
          acceptance: parsed.acceptance,
          fixPrompt: parsed.workflow.fixPrompt,
          verifyPrompt: parsed.workflow.verifyPrompt,
          verifyCommands: parsed.workflow.verifyCommands,
        };
      }
    } catch {
      /* LOOP.md missing/unparseable — config card stays hidden */
    }
  }
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
    config,
  };
}

// ── Create loop ────────────────────────────────────────────────────────────

export interface CreateLoopInput {
  name: string;
  /** Legacy free-form intent; superseded by goal/action/acceptance. */
  intent?: string;
  goal?: string;
  action?: string;
  acceptance?: string;
  /** Structured acceptance commands: the verify subagent MUST run each and
   *  paste output into evidence. Empty = prompt-only verification. */
  verifyCommands?: string[];
  projectId?: string;
  agent?: string;
  /** Cron expression; empty = manual loop. */
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

  // Four-element gate (loop-config-generator contract): goal / action /
  // acceptance must be present or the API asks, never writes an empty shell.
  const missing: string[] = [];
  if (!input.goal?.trim()) missing.push("goal");
  if (!input.action?.trim()) missing.push("action");
  if (!input.acceptance?.trim()) missing.push("acceptance");
  if (missing.length > 0) {
    return {
      status: "needs_clarification",
      questions: missing.map(
        (m) =>
          `缺少 ${m} 要素` +
          (m === "goal"
            ? "（要自动化什么？）"
            : m === "action"
              ? "（做什么 + 边界：自动修 / 只通知 / 生成报告）"
              : "（怎么算做好，如“相关测试全绿”）"),
      ),
    };
  }

  const loopName = input.name.trim().toLowerCase().replace(/\s+/g, "-");
  const loopPath = `loops/${loopName}`;
  const dir = `${dataDir}/${loopPath}`;

  // 1. Create cron_job row
  const job = await cronSvc.createCronJob({
    name: input.name,
    agentId: "default",
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
      agentId: "default",
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

  // 4. Workflow-first LOOP.md (goal/action/acceptance drive the prompts)
  await writeLoopMd(dir, {
    name: input.name,
    goal: input.goal!,
    action: input.action!,
    acceptance: input.acceptance!,
    verifyCommands: input.verifyCommands ?? [],
    projectId: input.projectId,
    agent: input.agent,
    settingsSvc,
  });

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
  await writeLoopMd(dir, {
    name: job.name,
    goal: "",
    action: "",
    acceptance: "",
    settingsSvc,
  });

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
    /** Repo builtin skills dir; forwarded to the Loop step. */
    builtinSkillsDir?: string;
    agentWorkspaceOf: (agentId: string) => Promise<string | null>;
    withWorkspaceLock: <T>(root: string, fn: () => Promise<T>) => Promise<T>;
    withLoopLock?: <T>(loopId: string, fn: () => Promise<T>) => Promise<T>;
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
    ...(deps.builtinSkillsDir ? { builtinSkillsDir: deps.builtinSkillsDir } : {}),
    agentWorkspaceOf: deps.agentWorkspaceOf,
    withWorkspaceLock: deps.withWorkspaceLock,
    ...(deps.withLoopLock ? { withLoopLock: deps.withLoopLock } : {}),
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
    /** Repo builtin skills dir; forwarded to the Loop step. */
    builtinSkillsDir?: string;
    agentWorkspaceOf: (agentId: string) => Promise<string | null>;
    withWorkspaceLock: <T>(root: string, fn: () => Promise<T>) => Promise<T>;
    withLoopLock?: <T>(loopId: string, fn: () => Promise<T>) => Promise<T>;
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
    ...(deps.builtinSkillsDir ? { builtinSkillsDir: deps.builtinSkillsDir } : {}),
    agentWorkspaceOf: deps.agentWorkspaceOf,
    withWorkspaceLock: deps.withWorkspaceLock,
    ...(deps.withLoopLock ? { withLoopLock: deps.withLoopLock } : {}),
  });

  return { state, action: input.verdict };
}

// ── Internal helpers ───────────────────────────────────────────────────────

const RUNTIME_SKILLS = ["loop-triage"] as const;

async function writeLoopMd(
  dir: string,
  input: {
    name: string;
    goal: string;
    action: string;
    acceptance: string;
    verifyCommands?: string[];
    projectId?: string;
    agent?: string;
    settingsSvc?: SettingsService;
  },
): Promise<void> {
  // LOOP.md stores the FULL canonical model ID (<provider>/<model>) - the
  // same key the Oma catalog validates.
  const model =
    input.settingsSvc?.get<string>("loop.generatorModel") ?? "anthropic/claude-sonnet-5";
  const dailyCap = input.settingsSvc?.get<number>("loop.defaultDailyCap") ?? 200000;
  const denylist = input.settingsSvc?.get<string[]>("loop.defaultDenylist") ?? [
    ".env",
    "auth/",
    "payments/",
    "secrets/",
  ];

  const denylistYaml = denylist.map((d) => `        - ${d}`).join("\n");
  const q = JSON.stringify;
  // Workflow-first: fix/verify prompts are rendered here from the four
  // elements; loopStep seeds the per-item script from these.
  const fixPrompt = `负责这个 Loop 的修复执行。目标: ${input.goal}。动作: ${input.action}。最小 diff,不提交,遵守 denylist。`;
  const verifyPrompt = `按验收标准验证修复: ${input.acceptance}。先运行相关测试/命令,把输出作为 evidence,再判定 PASS/REJECT/ESCALATE。`;
  await Bun.write(
    `${dir}/LOOP.md`,
    [
      "---",
      `projectId: ${input.projectId ?? ""}`,
      `agent: ${input.agent ?? "default"}`,
      `model: ${model}`,
      `acceptance: ${q(input.acceptance)}`,
      "workflow:",
      `  fixPrompt: ${q(fixPrompt)}`,
      `  verifyPrompt: ${q(verifyPrompt)}`,
      ...(input.verifyCommands && input.verifyCommands.length > 0
        ? ["  verifyCommands:", ...input.verifyCommands.map((c) => `    - ${q(c)}`)]
        : []),
      "safety:",
      "  denylist:",
      denylistYaml,
      "  maxRetries: 3",
      "  autoMerge: never",
      "budget:",
      `  dailyCap: ${dailyCap}`,
      "---",
      "",
      `# ${input.name}`,
      "",
      "## Goal",
      input.goal,
      "",
      "## Action",
      input.action,
      "",
      "## Acceptance",
      input.acceptance,
      "",
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
