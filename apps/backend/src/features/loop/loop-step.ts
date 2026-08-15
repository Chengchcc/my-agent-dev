import { join } from "node:path";
import type { BackendModelRef, BackendRunOutcome } from "@my-agent-team/agent-backend";
import type { LoopConfig, LoopState, Verdict } from "@my-agent-team/loop";
import { loopReducer, parseLoopConfig, validateLoopMetaPatch } from "@my-agent-team/loop";
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

function denylistedFiles(files: string[], patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  return files.filter((f) => patterns.some((p) => matchesGlob(f, p)));
}

/** Resolve the loop agent's (agent, project) worktree and hard-reset it to
 *  the project's default branch - the per-step clean start (ADR 0023 P2;
 *  replaces the retired per-step shallow clone). Returns null when the
 *  loop has no projectId. */
export async function resolveLoopWorktree(
  loopConfigPath: string,
  deps: {
    projectPort: ProjectPort | undefined;
    dataDir: string | undefined;
    agentWorkspaceOf: (agentId: string) => Promise<string | null>;
  },
): Promise<string | null> {
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
  // Clean start per step: the mirror was just fetched; the default branch
  // ref there IS the remote tip.
  const ref = project.defaultBranch
    ? `refs/heads/${project.defaultBranch}`
    : "refs/remotes/origin/HEAD";
  await Bun.$`git -C ${wt} reset --hard ${ref}`.quiet();
  return wt;
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

/** The workflow script the Loop seeds per item. The meta block carries
 *  the item's state (seeded as JSON); the model updates it after the run
 *  via the write tool, and the product validates the writeback with
 *  validateLoopMetaPatch before applying the verdict. */
const LOOP_WORKFLOW_TEMPLATE = `// Loop workflow (product-seeded). Update the meta block after the run
// with the item's new step (a legal transition) and its verdict result.
export const meta = __META_JSON__;

const item = Object.values(meta.items)[0];
const fix = await agent(
  \`Fix the loop item. Summary: \${item.summary}. Source: \${item.source}. Smallest possible diff; do not commit.\`,
  { label: \`\${item.id}-fix\` },
);
const verdict = await agent(
  \`Verify the fix for item \${item.id}. Run the relevant tests and return JSON: {"verdict":"PASS"|"REJECT"|"ESCALATE","reasons":[],"evidence":"..."}.\`,
  {
    label: \`\${item.id}-verify\`,
    schema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["PASS", "REJECT", "ESCALATE"] },
        reasons: { type: "array" },
        evidence: { type: "string" },
      },
      required: ["verdict", "evidence"],
    },
  },
);
// After this workflow, use the write tool to update the meta block above:
// the item's step (legal edge) and result (the verdict JSON above).
return { id: item.id, verdict: verdict.output, fixText: fix.text };
`;

function seedLoopWorkflowScript(item: LoopState["items"][string]): string {
  const metaJson = JSON.stringify({ items: { [item.id]: item } });
  return LOOP_WORKFLOW_TEMPLATE.replace("__META_JSON__", metaJson);
}

/** Extract the model-edited meta block: balanced-brace scan + lenient JSON
 *  (line comments + trailing commas stripped). Null = unparseable. */
function extractLoopWorkflowMeta(script: string): LoopState | null {
  const m = script.match(/export const meta\s*=\s*(\{[\s\S]*?\});/);
  if (!m?.[1]) return null;
  const cleaned = m[1].replace(/\/\/[^\n]*/g, "").replace(/,\s*([}\]])/g, "$1");
  try {
    const parsed = JSON.parse(cleaned) as { items?: LoopState["items"] };
    if (!parsed.items || typeof parsed.items !== "object") return null;
    return { loopId: "", lastRun: null, items: parsed.items };
  } catch {
    return null;
  }
}

function buildGeneratorPrompt(
  item: LoopState["items"][string],
  template: string,
  context?: { repoPath?: string; gitLog?: string },
): string {
  // The user prompt ALWAYS carries the item facts: summary, source,
  // rejection note and project context. The LOOP.md systemPrompt is only an
  // extra behavioral constraint (frozen into the Run as systemPrompt), so a
  // template that omits placeholders can never starve the agent of the item.
  let note = "";
  if (item.result && "reasons" in item.result) {
    note = `- 上次被拒原因: ${item.result.reasons.join("; ")}`;
  }
  const ctx = context?.repoPath
    ? `\n\n## Project Context\n- Repo: ${context.repoPath}\n${context.gitLog ? `- Recent changes:\n${context.gitLog}\n` : ""}`
    : "";
  const core = [
    `# Task\n${item.summary}`,
    `# Source\n${item.source}`,
    ...(note ? [note] : []),
  ].join("\n\n");
  const extra = template.trim();
  return `${core}${extra ? `\n\n# Additional Instructions\n${extra}` : ""}${ctx}`;
}

export async function loopStep(params: LoopStepParams): Promise<LoopState> {
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

  const genModel = cfg.generator.model;
  const genPrompt = cfg.generator.systemPrompt;
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
  const cwd = await resolveLoopWorktree(params.loopConfigPath, {
    projectPort: params.projectPort,
    dataDir: params.dataDir,
    agentWorkspaceOf: params.agentWorkspaceOf,
  });

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

    // ── Generator: one Agent Run per item, workflow-driven ──
    // The Loop seeds the workflow script (meta = this item's state); the
    // generator runs it (fix fan-out + self-verification) and writes the
    // verdict back into the script's meta via the write tool.
    const genConversationId = loopGeneratorConversationId(params.loopId);
    const genMemberId = loopGeneratorMemberId(params.loopId);
    await ensureLoopScope(params.convPort, genConversationId, genMemberId, cfg.agent || "default");
    const gitLog = await Bun.$`git log --oneline -5`
      .cwd(repoCwd)
      .quiet()
      .text()
      .catch(() => "");
    await Bun.write(`${repoCwd}/.workflows/loop.js`, seedLoopWorkflowScript(item)).catch(() => {});
    const genPromptFull = [
      buildGeneratorPrompt(item, genPrompt, { repoPath: repoCwd, gitLog }),
      `# Workflow\nThe script at .workflows/loop.js carries this item's state in its meta block. ` +
        `Run it with the workflow_run tool (pass the script text). After the workflow completes, ` +
        `use the write tool to update the meta block in .workflows/loop.js: the item's step must ` +
        `follow a legal transition and its result must be the verdict JSON from the verify agent.`,
    ].join("\n\n");
    const genSkillRoots = params.builtinSkillsDir
      ? [params.builtinSkillsDir, `${params.loopConfigPath}/skills`]
      : [`${params.loopConfigPath}/skills`];
    let genAcquire = await params.agentRunService.enqueueAndAcquire({
      conversationId: genConversationId,
      agentMemberId: genMemberId,
      backendKind: "coding_agent",
      mode: "normal",
      message: {
        role: "user",
        text: genPromptFull,
      },
      defaultModel: await params.resolveModel(genModel),
      configRevision: 1,
      idempotencyKey: `loop-gen:${params.loopId}:${item.id}:${baseSha}`,
      // LOOP.md generator systemPrompt is the frozen Run system prompt;
      // skills live in the loop config's skills/ dir + the builtin docs.
      systemPrompt: genPrompt || undefined,
      skillRoots: genSkillRoots,
      // Workspace is a Run execution fact: the Generator MUST run in the
      // cloned repo, not the loop-agent's own workspace.
      workspace: { root: repoCwd, access: "read_write" },
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
        backendKind: "coding_agent",
        mode: "normal",
        message: {
          role: "user",
          text: genPromptFull,
        },
        defaultModel: await params.resolveModel(genModel),
        configRevision: 1,
        idempotencyKey: `loop-gen:${params.loopId}:${item.id}:${baseSha}:retry`,
        systemPrompt: genPrompt || undefined,
        skillRoots: genSkillRoots,
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

    const headSha = (await git.revParse(repoCwd)).text().trim();
    const filesChanged = (await git.diff(repoCwd, baseSha, headSha)).text().trim();

    state = loopReducer(state, {
      type: "GENERATOR_DONE",
      itemId: item.id,
      // the item's run identity is now an Agent Run id
      generatorRunId: generatorRunId,
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
          evidence: "denylist check (pre-verifier)",
        },
      });
      await git.resetHard(repoCwd, baseSha);
      continue;
    }

    // ── Workflow verdict: the script's meta carries the result ──
    // The model wrote the verdict into .workflows/loop.js; the product
    // validates the writeback against the pure reducer invariants and
    // applies the EVALUATOR_VERDICT transition. No separate evaluator Run.
    const scriptText = await Bun.file(`${cwd}/.workflows/loop.js`)
      .text()
      .catch(() => "");
    const writtenMeta = extractLoopWorkflowMeta(scriptText);
    const seedMeta: LoopState = {
      loopId: params.loopId,
      lastRun: null,
      items: { [item.id]: item },
    };
    const noVerdict = (reason: string): Verdict => ({
      verdict: "ESCALATE",
      reasons: [reason],
      evidence: "",
    });
    let verdict: Verdict;
    if (!writtenMeta) {
      verdict = noVerdict("workflow script has no parseable meta block");
    } else {
      const validation = validateLoopMetaPatch(seedMeta, writtenMeta);
      if (!validation.ok) {
        verdict = noVerdict(`workflow meta writeback invalid: ${validation.reason}`);
      } else {
        verdict = writtenMeta.items[item.id]?.result ?? noVerdict("workflow wrote no verdict");
      }
    }
    state = loopReducer(state, {
      type: "EVALUATOR_VERDICT",
      itemId: item.id,
      verdict,
    });

    // Rollback on REJECT/ESCALATE
    const updatedItem = state.items[item.id];
    if (updatedItem && (updatedItem.step === "fixing" || updatedItem.step === "inbox")) {
      await git.resetHard(repoCwd, baseSha);
    } else if (verdict.verdict === "PASS" && cwd) {
      // PASS: commit the approved work onto the agent branch (H2 from the
      // landing review) — the model is told not to commit, so the product
      // layer does it. Without this the next step's clean-start reset
      // would destroy the approved changes and ahead would stay 0.
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
