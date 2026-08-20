import { join } from "node:path";
import type { BackendModelRef, BackendRunOutcome } from "@chengchenccc/agent-backend";
import type { LoopConfig, LoopState, Verdict } from "@chengchenccc/loop";
import { loopReducer, parseLoopConfig } from "@chengchenccc/loop";
import { isTerminalStatus } from "../agent-run/domain.js";
import type { AgentRunExecutionService } from "../agent-run/execution.js";
import type { AgentRunService } from "../agent-run/service.js";
import type { ConversationPort } from "../conversation/ports.js";
import type { ProjectPort } from "../project/ports.js";
import { ensureMirror, ensureWorktree } from "../project/worktree.js";
import type { LoopStateStore } from "./loop-state-store.js";

type ReviewAction = {
  itemId: string;
  verdict: "approve" | "reject" | "promote" | "retry" | "dismiss";
  feedback?: string;
};

export interface GitRunnerOutput {
  text(): string;
  exitCode?: number;
}

export interface GitRunner {
  revParse(cwd: string): Promise<GitRunnerOutput>;
  diff(cwd: string, base: string, head: string): Promise<GitRunnerOutput>;
  resetHard(cwd: string, sha: string): Promise<GitRunnerOutput>;
}
export interface LoopStepParams {
  loopConfigPath: string;
  action?: ReviewAction;
  projectPort?: ProjectPort;
  dataDir?: string;
  store: LoopStateStore;
  loopId: string;
  /** Inject for tests. Default = real Bun.$ git calls. */
  gitRunner?: GitRunner;
  /** Canonical scope sink: deterministic Loop conversations/members live in
   *  the Conversation port (identity/audit containers, NOT a memory system). */
  convPort: ConversationPort;
  /** Phase 4 Agent Run services - the only execution path. */
  agentRunService: AgentRunService;
  agentRunExecution: AgentRunExecutionService;
  /** Resolve a LOOP.md model name to a BackendModelRef. */
  resolveModel: (modelName: string) => Promise<BackendModelRef>;
  /** The repo builtin skills dir (workflow authoring etc.); prepended to
   *  the generator's skill roots when provided. */
  builtinSkillsDir?: string;
  /** Resolve a LOOP.md agent id to its workspace path (null = unknown
   *  agent). Wired from the composition root via agentSvc. */
  agentWorkspaceOf: (agentId: string) => Promise<string | null>;
  /** Shared per-worktree lock (A4): run dispatch, loop clean-start/reset
   *  and agent detach serialize against each other. */
  withWorkspaceLock: <T>(root: string, fn: () => Promise<T>) => Promise<T>;
  /** Per-loop state lock: serializes load -> reducer -> save across cron
   *  ticks, manual run and review (Bug 1). Injected from the composition
   *  root; tests may pass a no-op. */
  withLoopLock?: <T>(loopId: string, fn: () => Promise<T>) => Promise<T>;
}

/** Stable deterministic identities - Generator and Evaluator are fully
 *  independent scopes (separate conversations, separate members). */
export function loopGeneratorConversationId(loopId: string): string {
  return `loop:${loopId}:generator`;
}
export function loopGeneratorMemberId(loopId: string): string {
  return `loop-generator:${loopId}`;
}

function usageTokens(usage: BackendRunOutcome["usage"] | null | undefined): number {
  if (!usage) return 0;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/** Idempotently ensure the deterministic Conversation + Agent Member exist.
 *  The branch is lazily created by enqueueAndAcquire. */
async function ensureLoopScope(
  convPort: ConversationPort,
  conversationId: string,
  agentMemberId: string,
  agentId: string,
): Promise<void> {
  if (!convPort.getConversation(conversationId)) {
    try {
      convPort.createConversation({
        conversationId,
        triggerMode: "mention",
        origin: "loop",
        createdAt: Date.now(),
      });
    } catch {
      /* concurrent create - ignore */
    }
  }
  const members = convPort.getMembers(conversationId);
  if (!members.some((m) => m.memberId === agentMemberId)) {
    convPort.addMember({
      memberId: agentMemberId,
      conversationId,
      kind: "agent",
      agentId,
      joinedAt: Date.now(),
    });
  }
}

// === denylist glob matching ===
function matchesGlob(path: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
        .join(".*") +
      "$",
  );
  return regex.test(path);
}

/** All paths the run touched: untracked + modified (porcelain) plus
 *  anything the model managed to commit on top of baseSha (A2 — the old
 *  diff-based check missed uncommitted files entirely). */
async function collectChangedPaths(repoCwd: string, baseSha: string): Promise<string[]> {
  const porcelain = await Bun.$`git -C ${repoCwd} status --porcelain=v1 -uall`.quiet().text();
  const worktreePaths = porcelain
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  const committed = await Bun.$`git -C ${repoCwd} diff --name-only ${baseSha}..HEAD`
    .quiet()
    .nothrow()
    .text();
  const committedPaths = committed
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return [...new Set([...worktreePaths, ...committedPaths])];
}

function denylistedFiles(files: string[], patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  return files.filter((f) => patterns.some((p) => matchesGlob(f, p)));
}

/** Resolve the loop agent's (agent, project) worktree and hard-reset it to
 *  the project's default branch - the per-step clean start (ADR 0023 P2;
 *  replaces the retired per-step shallow clone). Returns null when the
 *  loop has no projectId. */
export interface LoopWorktree {
  cwd: string;
  mirror: string;
  base: string;
}

export async function resolveLoopWorktree(
  loopConfigPath: string,
  deps: {
    projectPort: ProjectPort | undefined;
    dataDir: string | undefined;
    agentWorkspaceOf: (agentId: string) => Promise<string | null>;
  },
): Promise<LoopWorktree | null> {
  const { projectPort, dataDir, agentWorkspaceOf } = deps;
  if (!projectPort || !dataDir) return null;
  let cfg: LoopConfig | null;
  try {
    cfg = parseLoopConfig(await Bun.file(`${loopConfigPath}/LOOP.md`).text());
  } catch {
    return null;
  }
  const projectId = cfg?.projectId;
  if (!projectId) return null;
  const project = projectPort.getProject(projectId);
  if (!project?.repoUrl) {
    throw new Error(`loopStep: project ${projectId} has no repoUrl`);
  }
  const agentId = cfg?.agent || "default";
  const agentWs = await agentWorkspaceOf(agentId);
  if (!agentWs) {
    throw new Error(`loopStep: LOOP.md agent "${agentId}" not found`);
  }
  const mirror = await ensureMirror(dataDir, {
    projectId: project.projectId,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
  });
  const wt = await ensureWorktree(
    mirror,
    agentWs,
    {
      projectId: project.projectId,
      repoUrl: project.repoUrl,
      defaultBranch: project.defaultBranch,
    },
    agentId,
  );
  if (!wt) {
    throw new Error(`loopStep: worktree slot occupied at ${join(agentWs, "projects", projectId)}`);
  }
  const base = await resolveBaseBranch(mirror, project.defaultBranch);
  return { cwd: wt, mirror, base };
}

/** Resolve the project's base branch name inside the mirror: the recorded
 *  defaultBranch, else the remote HEAD the mirror cloned from (never the
 *  nonexistent refs/remotes/origin/HEAD path). */
export async function resolveBaseBranch(
  mirror: string,
  defaultBranch: string | null,
): Promise<string> {
  if (defaultBranch) return defaultBranch;
  const head = await Bun.$`git -C ${mirror} symbolic-ref --short HEAD`.nothrow().quiet().text();
  const resolved = head.trim();
  if (!resolved) {
    throw new Error("loopStep: cannot resolve the project's default branch (empty mirror HEAD)");
  }
  return resolved;
}

/** Per-step clean start (A1): start from the agent branch's own committed
 *  state, never from the base — PASS commits must survive the next tick.
 *  Uncommitted leftovers (failed runs, hand edits) are wiped. */
export async function loopCleanStart(wt: string, _mirror: string, base: string): Promise<void> {
  // Count against the WORKTREE's HEAD (the agent branch): the mirror's own
  // HEAD is the default branch and would compare the wrong side.
  const counts = await Bun.$`git -C ${wt} rev-list --left-right --count refs/heads/${base}...HEAD`
    .nothrow()
    .quiet()
    .text();
  const [behindRaw, aheadRaw] = counts.trim().split(/\s+/);
  const behind = Number(behindRaw ?? 0);
  const ahead = Number(aheadRaw ?? 0);
  if (behind > 0 && ahead > 0) {
    // Real divergence: both sides advanced past the merge-base. Refuse —
    // wiping the branch's own commits would destroy approved work.
    throw new Error(
      `loopStep: agent branch and base ${base} diverged; merge via the project page before the next tick`,
    );
  }
  if (behind > 0 && ahead === 0) {
    // Strictly behind (nothing of its own): follow the base.
    await Bun.$`git -C ${wt} reset --hard refs/heads/${base}`.quiet();
  } else {
    // At or ahead of the base: start each step from the branch's own
    // committed state (PASS commits survive), wiping uncommitted noise.
    await Bun.$`git -C ${wt} reset --hard HEAD`.quiet();
  }
  await Bun.$`git -C ${wt} clean -fd`.quiet();
}

function actionToReducer(action: ReviewAction) {
  switch (action.verdict) {
    case "approve":
      return { type: "APPROVE" as const, itemId: action.itemId };
    case "reject":
      return { type: "REJECT_HUMAN" as const, itemId: action.itemId, feedback: action.feedback };
    case "promote":
      return { type: "PROMOTE" as const, itemId: action.itemId };
    case "retry":
      return { type: "RETRY" as const, itemId: action.itemId };
    case "dismiss":
      return { type: "DISMISS" as const, itemId: action.itemId };
  }
}

/** Render the per-item workflow script: fix then verify, both as subagents.
 *  Prompts come from LOOP.md workflow.fixPrompt/verifyPrompt when set, else
 *  defaults derived from the item + acceptance criteria (workflow-first:
 *  the script IS the generator/evaluator, no outer agent role). */
function renderLoopWorkflow(
  item: LoopState["items"][string],
  cfg: LoopConfig,
  ctx?: { gitLog?: string },
): string {
  const gitCtx = ctx?.gitLog ? `\nRecent changes:\n${ctx.gitLog}` : "";
  const fixPrompt =
    cfg.workflow.fixPrompt ||
    `Fix the loop item. Summary: ${item.summary}. Source: ${item.source}. Smallest possible diff; do not commit.${gitCtx}`;
  const verifyPrompt =
    cfg.workflow.verifyPrompt ||
    (cfg.acceptance
      ? `Verify the fix for item ${item.id} against the acceptance criteria: ${cfg.acceptance}. ` +
        `Run the relevant tests/commands first, capture their output, then return JSON: ` +
        `{"verdict":"PASS"|"REJECT"|"ESCALATE","reasons":[],"evidence":"<command output>"}.`
      : `Verify the fix for item ${item.id}. Run the relevant tests and return JSON: ` +
        `{"verdict":"PASS"|"REJECT"|"ESCALATE","reasons":[],"evidence":"..."}.`);
  return `// Loop workflow (product-rendered per item). fix then verify.
const item = args.item;
const fix = await agent(${JSON.stringify(fixPrompt)}, { label: "fix" });
const verdict = await agent(${JSON.stringify(verifyPrompt)}, {
  label: "verify",
  schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["PASS", "REJECT", "ESCALATE"] },
      reasons: { type: "array" },
      evidence: { type: "string" },
    },
    required: ["verdict", "evidence"],
  },
});
return { id: item.id, verdict: verdict.output, fixText: fix.text };
`;
}

/** Normalize a workflow script's return value into a Verdict. Malformed
 *  output escalates (the worktree keeps changes for human review). */
function verdictFromWorkflow(
  value: unknown,
  changed: boolean,
  changedFiles: string[],
  fallbackReason: string,
): Verdict {
  const raw =
    value && typeof value === "object"
      ? (value as { verdict?: unknown; evidence?: unknown; reasons?: unknown })
      : null;
  const v = raw?.verdict;
  const evidence = typeof raw?.evidence === "string" ? raw.evidence : "";
  const reasons = Array.isArray(raw?.reasons) ? raw.reasons.map(String) : [];
  if (v === "PASS") return { verdict: "PASS", evidence };
  if (v === "REJECT") return { verdict: "REJECT", reasons, evidence };
  if (v === "ESCALATE") return { verdict: "ESCALATE", reasons, evidence };
  // Bug 4 semantics: changed work with an unusable verdict must NOT be
  // rolled back silently — route it to human review via PASS-with-evidence.
  if (changed) {
    return {
      verdict: "PASS",
      evidence: `${fallbackReason}; changed: ${changedFiles.join(", ")}`,
    };
  }
  return { verdict: "ESCALATE", reasons: [fallbackReason], evidence: "" };
}

export async function loopStep(params: LoopStepParams): Promise<LoopState> {
  // Per-loop serialization across ALL entry points (cron tick, HTTP run,
  // HTTP review): load -> reducer -> save must never interleave, or the
  // later save clobbers the earlier one's reducer output.
  if (params.withLoopLock) {
    return params.withLoopLock(params.loopId, () => loopStepImpl(params));
  }
  return loopStepImpl(params);
}

async function loopStepImpl(params: LoopStepParams): Promise<LoopState> {
  // 1. Read state from DB
  let state = params.store.load(params.loopId);
  // inboxItems stored as items with step="inbox" — separate them
  const inboxItems: LoopState["items"] = {};
  const activeItems: LoopState["items"] = {};
  for (const [id, item] of Object.entries(state.items)) {
    if (item.step === "inbox") {
      inboxItems[id] = item;
    } else {
      activeItems[id] = item;
    }
  }
  state = { ...state, items: activeItems };

  // Read LOOP.md config (required — model/prompt come from registry via LOOP.md)
  const loopMdPath = `${params.loopConfigPath}/LOOP.md`;
  let cfg: LoopConfig;
  try {
    const md = await Bun.file(loopMdPath).text();
    const parsed = parseLoopConfig(md);
    if (!parsed) throw new Error("parseLoopConfig returned null");
    cfg = parsed;
  } catch (err) {
    throw new Error(`loopStep: failed to load LOOP.md config from ${loopMdPath}: ${String(err)}`, {
      cause: err,
    });
  }

  const denylist: string[] = cfg.denylist;
  const dailyCap = cfg.budget?.dailyCap ?? 0;

  // 2. Human review action
  if (params.action) {
    const action = params.action;

    if (action.verdict === "retry") {
      const item = inboxItems[action.itemId];
      if (item) {
        state = loopReducer(state, {
          type: "ADD_ITEM",
          item: { id: item.id, source: item.source, summary: item.summary },
          priority: item.priority,
        });
        state = loopReducer(state, { type: "TICK" });
        delete inboxItems[action.itemId];
      }
    } else if (action.verdict === "dismiss") {
      delete inboxItems[action.itemId];
    } else {
      const itemInState = state.items[action.itemId];
      const itemInInbox = inboxItems[action.itemId];
      if (itemInState) {
        state = loopReducer(state, actionToReducer(action));
      } else if (itemInInbox) {
        state = loopReducer(
          {
            ...state,
            items: { ...state.items, [action.itemId]: itemInInbox },
          },
          actionToReducer(action),
        );
      }
    }

    params.store.save(params.loopId, state, inboxItems);
    return state;
  }

  // The worktree is materialized ONLY for the generator path: review
  // actions early-return above and must never reset a worktree that a
  // live run may hold (H1 from the landing review).
  const resolved = await resolveLoopWorktree(params.loopConfigPath, {
    projectPort: params.projectPort,
    dataDir: params.dataDir,
    agentWorkspaceOf: params.agentWorkspaceOf,
  });
  const cwd = resolved?.cwd ?? null;
  if (resolved) {
    // A1/A4: per-step clean start under the shared workspace lock — a
    // live run holding this worktree settles first.
    const { cwd: wt, mirror, base } = resolved;
    try {
      await params.withWorkspaceLock(wt, () => loopCleanStart(wt, mirror, base));
    } catch (divergeErr) {
      // Bug 5: a diverged worktree must not kill the whole tick. Escalate
      // the affected fixing items to manual review, persist, and stop.
      const reasons = [String(divergeErr)];
      for (const it of Object.values(state.items)) {
        if (it.step === "fixing") {
          state = loopReducer(state, {
            type: "EVALUATOR_VERDICT",
            itemId: it.id,
            verdict: {
              verdict: "ESCALATE",
              reasons,
              evidence: "worktree diverged — manual merge required",
            },
          });
        }
      }
      await params.store.save(params.loopId, state, inboxItems);
      return state;
    }
  }

  // 3. Cron TICK — Generator → Evaluator
  state = loopReducer(state, { type: "TICK" });

  const fixingItems = Object.values(state.items).filter((i) => i.step === "fixing");

  // Fail closed: never run git mutations without a resolved worktree.
  if (fixingItems.length > 0 && !cwd) {
    throw new Error(
      "loopStep: cannot process fixing items without a resolved worktree " +
        "(check LOOP.md projectId/agent, project.repoUrl, and that projectPort/dataDir are wired)",
    );
  }
  const repoCwd: string = cwd ?? ".";

  const git = params.gitRunner ?? {
    revParse: (cwd: string) => Bun.$`git rev-parse HEAD`.cwd(cwd).quiet(),
    diff: (cwd: string, base: string, head: string) =>
      Bun.$`git diff --name-only ${base}..${head}`.cwd(cwd).quiet(),
    resetHard: (cwd: string, sha: string) =>
      Bun.$`git reset --hard ${sha}`.cwd(cwd).quiet().nothrow(),
  };

  const today = new Date().toISOString().slice(0, 10);
  let spent = dailyCap > 0 ? params.store.getBudget(params.loopId, today) : 0;
  let budgetNotified = false;

  const notifyBudgetExceeded = () => {
    if (budgetNotified) return;
    budgetNotified = true;
    const ts = Date.now();
    try {
      params.convPort.appendLedgerEntry({
        conversationId: params.loopId,
        senderMemberId: "__system__",
        addressedTo: [],
        kind: "message",
        content: JSON.stringify({
          type: "budget_exceeded",
          spent,
          cap: dailyCap,
          message: `[系统] Loop 今日预算已耗尽（${spent}/${dailyCap}），暂停执行，明日自动恢复。`,
        }),
        ts,
      });
    } catch (e) {
      console.error(`[loop] budget notification failed: ${String(e)}`);
    }
  };

  // Pre-loop check: budget may already be exhausted from earlier runs today.
  if (dailyCap > 0 && spent >= dailyCap) {
    notifyBudgetExceeded();
  }
  for (const item of fixingItems) {
    if (dailyCap > 0 && spent >= dailyCap) {
      notifyBudgetExceeded();
      break;
    }

    const baseSha = (await git.revParse(repoCwd)).text().trim();

    // ── Generator: one workflow-mode Agent Run per item ──
    // Workflow-first: the script IS fix + verify (subagents); the run
    // executes it directly and returns { verdict, evidence } as
    // outcome.workflow.value. No outer agent role, no meta writeback.
    const genConversationId = loopGeneratorConversationId(params.loopId);
    const genMemberId = loopGeneratorMemberId(params.loopId);
    await ensureLoopScope(params.convPort, genConversationId, genMemberId, cfg.agent || "default");
    const gitLog = await Bun.$`git log --oneline -5`
      .cwd(repoCwd)
      .quiet()
      .text()
      .catch(() => "");
    const workflowScript = renderLoopWorkflow(item, cfg, { gitLog });
    const workflowArgs = { item };
    let genAcquire = await params.agentRunService.enqueueAndAcquire({
      conversationId: genConversationId,
      agentMemberId: genMemberId,
      backendKind: "oma",
      mode: "normal",
      message: { role: "user", text: `Loop item ${item.id}: ${item.summary}` },
      defaultModel: await params.resolveModel(cfg.model),
      configRevision: 1,
      idempotencyKey: `loop-gen:${params.loopId}:${item.id}:${baseSha}`,
      // The workflow runs in the cloned repo; subagents get file tools there.
      workspace: { root: repoCwd, access: "read_write" },
      workflow: { script: workflowScript, args: workflowArgs },
      // Freeze the remaining daily budget on the Run: the child's workflow
      // executor gates subagent spawns against it.
      ...(dailyCap > 0 ? { workflowBudgetTokens: Math.max(0, dailyCap - spent) } : {}),
    });
    if (
      genAcquire.replayed &&
      genAcquire.run &&
      isTerminalStatus(genAcquire.run.status) &&
      genAcquire.run.status !== "completed"
    ) {
      // The previous attempt for this (item, baseSha) ended terminal without
      // committing (failed/aborted/timeout) - replaying it would short-
      // circuit forever. Issue a fresh run for the retry.
      const retry = await params.agentRunService.enqueueAndAcquire({
        conversationId: genConversationId,
        agentMemberId: genMemberId,
        backendKind: "oma",
        mode: "normal",
        message: { role: "user", text: `Loop item ${item.id}: ${item.summary}` },
        defaultModel: await params.resolveModel(cfg.model),
        configRevision: 1,
        // A retry is a FRESH attempt after a failure - replay safety is the
        // wrong invariant here. A static suffix replays the same dead run
        // forever (acquired=true on a failed run); item.attempt only grows
        // on a REJECT verdict, so generator failures (which throw before
        // any verdict) would reuse the same key across ticks. Date.now()
        // is the monotonic component: one fresh run per tick after failure.
        idempotencyKey: `loop-gen:${params.loopId}:${item.id}:${baseSha}:retry:${Date.now()}`,
        workspace: { root: repoCwd, access: "read_write" },
        ...(dailyCap > 0 ? { workflowBudgetTokens: Math.max(0, dailyCap - spent) } : {}),
      });
      if (retry.acquired && retry.run) {
        genAcquire = { ...retry, replayed: false };
      }
    }
    if (!genAcquire.acquired || !genAcquire.run) {
      throw new Error(
        `loopStep: generator run for item ${item.id} could not acquire its branch (queued behind an active run)`,
      );
    }
    const generatorRunId = genAcquire.run.runId;
    await params.agentRunExecution.dispatch(generatorRunId);
    const genRun = await params.agentRunService.getRun(generatorRunId);
    if (genRun?.status !== "completed") {
      throw new Error(`loopStep: generator run ${generatorRunId} ended ${genRun?.status}`);
    }
    if (dailyCap > 0) {
      spent = params.store.addBudget(
        params.loopId,
        today,
        usageTokens(genRun.terminalResult?.usage),
      );
    }

    state = loopReducer(state, {
      type: "GENERATOR_DONE",
      itemId: item.id,
      // the item's run identity is now an Agent Run id
      generatorRunId: generatorRunId,
    });

    const changedFiles = await collectChangedPaths(repoCwd, baseSha);
    const violations = denylistedFiles(changedFiles, denylist);
    if (violations.length > 0) {
      state = loopReducer(state, {
        type: "EVALUATOR_VERDICT",
        itemId: item.id,
        verdict: {
          verdict: "REJECT",
          reasons: [`修改了 denylist 保护路径: ${violations.join(", ")}`],
          evidence: "denylist check (pre-verifier)",
        },
      });
      await git.resetHard(repoCwd, baseSha);
      await Bun.$`git -C ${repoCwd} clean -fd`.quiet();
      continue;
    }

    // ── Workflow verdict: the script's return value is the result ──
    // outcome.workflow.value carries { verdict, evidence } from the verify
    // subagent (schema-parsed). Malformed output escalates; changed work is
    // preserved for human review (Bug 4 semantics).
    const wf =
      genRun.terminalResult?.status === "completed" ? genRun.terminalResult.workflow : undefined;
    const changed = changedFiles.length > 0;
    const verdict = verdictFromWorkflow(
      wf?.value,
      changed,
      changedFiles,
      `workflow run ${generatorRunId} returned no valid verdict`,
    );
    state = loopReducer(state, {
      type: "EVALUATOR_VERDICT",
      itemId: item.id,
      verdict,
    });

    // Rollback on REJECT/ESCALATE. Bug 4: changed-without-verdict now routes
    // through a PASS verdict to awaiting_review, so the rollback guard only
    // fires when the item actually returned to inbox/fixing (REJECT /
    // pure ESCALATE) — the worktree keeps changes for the human to review.
    const updatedItem = state.items[item.id];
    const rolledBack = updatedItem?.step === "fixing" || updatedItem?.step === "inbox";
    if (rolledBack) {
      await git.resetHard(repoCwd, baseSha);
      await Bun.$`git -C ${repoCwd} clean -fd`.quiet();
    } else if (verdict.verdict === "PASS" && cwd) {
      // PASS: commit the approved work onto the agent branch (H2 from the
      // landing review) — the fix subagent is told not to commit, so the
      // product layer does it. Without this the next step's clean-start
      // reset would destroy the approved changes and ahead would stay 0.
      const staged = await Bun.$`git -C ${cwd} status --porcelain`.quiet().text();
      if (staged.trim()) {
        await Bun.$`git -C ${cwd} add -A`.quiet();
        await Bun.$`git -C ${cwd} -c user.email=loop@agent -c user.name=loop commit -qm ${`loop ${params.loopId} item ${item.id}`}`.quiet();
      }
    }
  }

  // 4. Write back
  params.store.save(params.loopId, state, inboxItems);
  return state;
}
