import { existsSync } from "node:fs";
import { createAgentSession } from "@my-agent-team/agent";
import type { AgentConfig as SessionConfig, SessionManager } from "@my-agent-team/agent";
import type { LoopConfig, LoopState } from "@my-agent-team/loop";
import { loopReducer, parseLoopConfig, parseVerdictMd } from "@my-agent-team/loop";
import type { AppendLedgerInput } from "../conversation/ports.js";
import type { ProjectPort } from "../project/ports.js";
import { nodeFsAdapter } from "../skill-pack/fs-adapter.js";
import type { SkillRoots } from "../span/skill-roots.js";
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
  sessionManager: SessionManager;
  buildConfig: (params: {
    modelName: string;
    cwd: string;
    skillRoots?: SkillRoots;
  }) => SessionConfig;
  action?: ReviewAction;
  projectPort?: ProjectPort;
  dataDir?: string;
  store: LoopStateStore;
  loopId: string;
  /** Inject for tests. Default = real Bun.$ git calls. */
  gitRunner?: GitRunner;
  /** Optional sink for budget-exceeded notifications into the conversation ledger. */
  convPort?: {
    appendLedgerEntry: (input: AppendLedgerInput) => unknown;
  };
}

async function tallyUsage(sessionManager: SessionManager, sessionId: string): Promise<number> {
  const session = sessionManager.get(sessionId);
  if (!session) return 0;
  return session.getUsage();
}

// === denylist glob matching ===
function matchesGlob(path: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexBody = escaped
    .replace(/\*\*/g, "[DBL]")
    .replace(/\*/g, "[^/]*")
    .split("[DBL]")
    .join(".*");
  return new RegExp(`^${regexBody}$`).test(path);
}

function denylistedFiles(files: string[], patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  return files.filter((f) => patterns.some((p) => matchesGlob(f, p)));
}

async function resolveRepoPath(
  loopConfigPath: string,
  projectPort: ProjectPort | undefined,
  dataDir: string | undefined,
): Promise<string | null> {
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
  const repoPath = `${dataDir}/repos/${projectId}`;
  const branch = project.defaultBranch ?? "main";
  if (!existsSync(repoPath)) {
    await Bun.$`git clone --depth 1 --branch ${branch} ${project.repoUrl} ${repoPath}`.quiet();
  } else {
    await Bun.$`git fetch origin`.cwd(repoPath).quiet();
    await Bun.$`git checkout ${branch}`.cwd(repoPath).quiet();
    await Bun.$`git reset --hard origin/${branch}`.cwd(repoPath).quiet();
  }
  const ok =
    (await Bun.$`git -C ${repoPath} rev-parse --is-inside-work-tree`.quiet().nothrow()).exitCode ===
    0;
  if (!ok) throw new Error(`loopStep: repoPath is not a git work tree: ${repoPath}`);
  return repoPath;
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

function buildGeneratorPrompt(
  item: LoopState["items"][string],
  template: string,
  context?: { repoPath?: string; gitLog?: string },
): string {
  let note = "";
  if (item.result && "reasons" in item.result) {
    note = `- 上次被拒原因: ${item.result.reasons.join("; ")}`;
  }
  const ctx = context?.repoPath
    ? `\n\n## Project Context\n- Repo: ${context.repoPath}\n${context.gitLog ? `- Recent changes:\n${context.gitLog}\n` : ""}`
    : "";
  return template
    .replace("{summary}", item.summary)
    .replace("{source}", item.source)
    .replace("{rejectionNote}", note)
    .concat(ctx);
}

export async function loopStep(params: LoopStepParams): Promise<LoopState> {
  return loopStepImpl(params);
}

async function loopStepImpl(params: LoopStepParams): Promise<LoopState> {
  const repoPath = await resolveRepoPath(params.loopConfigPath, params.projectPort, params.dataDir);
  const workDir = repoPath ?? params.loopConfigPath;

  // Construct role-specific skill roots from .loop/skills
  const skillsDir = `${params.loopConfigPath}/skills`;
  const skillRootsByRole = (role: string): SkillRoots => ({
    ws: nodeFsAdapter(skillsDir),
    roots: [role],
    posixSkillRoot: skillsDir,
  });

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

  const genModel = cfg.generator.model;
  const evalModel = cfg.evaluator.model;
  // model≠ already checked in parseLoopConfig — this is defensive
  const genPrompt = cfg.generator.systemPrompt;
  const evalPrompt = cfg.evaluator.systemPrompt;
  const acceptance = cfg.acceptance || "被修改的文件相关测试全绿，改动范围合理";
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

  // 3. Cron TICK — Generator → Evaluator
  state = loopReducer(state, { type: "TICK" });

  const fixingItems = Object.values(state.items).filter((i) => i.step === "fixing");

  // Fail closed: never run git mutations against the backend's own cwd.
  const gitCwd = repoPath;
  if (fixingItems.length > 0 && !gitCwd) {
    throw new Error(
      "loopStep: cannot process fixing items without a resolved repoPath " +
        "(check LOOP.md projectId, project.repoUrl, and that projectPort/dataDir are wired)",
    );
  }

  // TS guard: gitCwd is definitely string after the throw above when fixingItems.length > 0
  const cwd = gitCwd!;

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
    if (!params.convPort || budgetNotified) return;
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

    const baseSha = (await git.revParse(cwd)).text().trim();

    // Generator
    const genConfig = params.buildConfig({
      modelName: genModel,
      cwd: workDir,
      skillRoots: skillRootsByRole("loop-generator"),
    });

    const genSession = await createAgentSession({ ...genConfig, sessionManager: params.sessionManager });
    let genSpanId: string | undefined;
    const unsubGen = genSession.subscribe((e) => {
      if (e.type === "agent_start") genSpanId = e.spanId;
    });
    const gitLog = await Bun.$`git log --oneline -5`
      .cwd(cwd)
      .quiet()
      .text()
      .catch(() => "");
    await genSession.prompt(buildGeneratorPrompt(item, genPrompt, { repoPath: cwd, gitLog }));
    unsubGen();
    if (dailyCap > 0) {
      spent = params.store.addBudget(
        params.loopId,
        today,
        await tallyUsage(params.sessionManager, genSession.sessionId ?? ""),
      );
    }
    params.sessionManager.dispose(genSession.sessionId ?? "");

    const headSha = (await git.revParse(cwd)).text().trim();
    const filesChanged = (await git.diff(cwd, baseSha, headSha)).text().trim();

    state = loopReducer(state, {
      type: "GENERATOR_DONE",
      itemId: item.id,
      generatorSpanId: genSpanId,
    });

    const changedFiles = filesChanged ? filesChanged.split("\n").filter(Boolean) : [];
    const violations = denylistedFiles(changedFiles, denylist);
    if (violations.length > 0) {
      state = loopReducer(state, {
        type: "EVALUATOR_VERDICT",
        itemId: item.id,
        verdict: {
          verdict: "REJECT",
          reasons: [`修改了 denylist 保护路径: ${violations.join(", ")}`],
          evidence: "denylist check (pre-evaluator)",
        },
      });
      await git.resetHard(cwd, baseSha);
      continue;
    }

    // Evaluator
    const evaluatorPrompt = evalPrompt
      .replace("{acceptance}", acceptance)
      .replace("{filesChanged}", filesChanged || "none");
    const evalConfig = params.buildConfig({
      modelName: evalModel,
      cwd: workDir,
      skillRoots: skillRootsByRole("loop-verifier"),
    });

    const verdictPath = `${workDir}/VERDICT.md`;
    try {
      await Bun.write(verdictPath, "");
    } catch {
      // ignore
    }

    const evalSession = await createAgentSession({ ...evalConfig, sessionManager: params.sessionManager });
    const EVALUATOR_TIMEOUT_MS = 60_000;
    await Promise.race([
      evalSession.prompt(evaluatorPrompt),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Evaluator timeout")), EVALUATOR_TIMEOUT_MS),
      ),
    ]).catch(() => {
      console.error(`[loop] evaluator timeout/crash for item ${item.id}`);
    });
    if (dailyCap > 0) {
      spent = params.store.addBudget(
        params.loopId,
        today,
        await tallyUsage(params.sessionManager, evalSession.sessionId ?? ""),
      );
    }
    params.sessionManager.dispose(evalSession.sessionId ?? "");
    // Read verdict
    const verdictMd = await Bun.file(verdictPath)
      .text()
      .catch(() => "");
    let verdict = parseVerdictMd(verdictMd);
    if (!verdictMd.trim()) {
      verdict = { verdict: "ESCALATE", reasons: ["evaluator produced no verdict"], evidence: "" };
    }

    if (verdict) {
      state = loopReducer(state, {
        type: "EVALUATOR_VERDICT",
        itemId: item.id,
        verdict,
      });
    }

    // Rollback on REJECT/ESCALATE
    const updatedItem = state.items[item.id];
    if (updatedItem && (updatedItem.step === "fixing" || updatedItem.step === "inbox")) {
      await git.resetHard(cwd, baseSha);
    }
  }

  // 4. Write back
  params.store.save(params.loopId, state, inboxItems);
  return state;
}
