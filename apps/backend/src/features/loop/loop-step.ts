import { existsSync } from "node:fs";
import type { BackendModelRef, BackendRunOutcome } from "@my-agent-team/agent-backend";
import type { LoopConfig, LoopState, Verdict } from "@my-agent-team/loop";
import { loopReducer, parseLoopConfig, validateLoopMetaPatch } from "@my-agent-team/loop";
import { isTerminalStatus } from "../agent-run/domain.js";
import type { AgentRunExecutionService } from "../agent-run/execution.js";
import type { AgentRunService } from "../agent-run/service.js";
import type { ConversationPort } from "../conversation/ports.js";
import type { ProjectPort } from "../project/ports.js";
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
  /** The files existing at sha (one per line). */
  lsTree(cwd: string, sha: string): Promise<GitRunnerOutput>;
  /** Restore the given files to their sha content (selective rollback). */
  checkoutFiles(cwd: string, sha: string, files: readonly string[]): Promise<GitRunnerOutput>;
  /** Remove the given files from the index + worktree (new-file rollback). */
  removeFiles(cwd: string, files: readonly string[]): Promise<GitRunnerOutput>;
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

/** Resolve (and materialize) the loop's cloned repo workspace. Exported so
 *  the composition root can bind Agent Run workspaces for loop scopes to the
 *  actual clone, not the loop-agent's own workspace. */
export async function resolveRepoPath(
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

/** The workflow script the Loop seeds per item. The meta block carries
 *  the item's state (seeded as JSON); the model updates it after the run
 *  via the write tool, and the product validates the writeback with
 *  validateLoopMetaPatch before applying the verdict. */
const LOOP_WORKFLOW_TEMPLATE = `// Loop workflow (product-seeded). Update the meta block after the run.
export const meta = __META_JSON__;

const results = await pipeline(Object.values(meta.items), async (item) => {
  const fix = await agent(
    \`Fix loop item \${item.id}: \${item.summary}. Source: \${item.source}. Smallest possible diff; do not commit. End your reply with the exact list of files you changed, one path per line.\`,
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
  return { id: item.id, verdict: verdict.output, fixText: fix.text };
});

// After this workflow, use the write tool to update the meta block: for EACH
// item set step (a legal edge), result (the verdict JSON), and touchedFiles
// (the file list the fix agent reported, as a JSON array of strings).
return results;
`;

function seedLoopWorkflowScript(items: readonly LoopState["items"][string][]): string {
  const byId: LoopState["items"] = {};
  for (const item of items) byId[item.id] = item;
  return LOOP_WORKFLOW_TEMPLATE.replace("__META_JSON__", JSON.stringify({ items: byId }));
}

/** Revert one item's files to the base commit (existing files restored,
 *  new files removed). Trusts the model's touchedFiles attribution - the
 *  denylist check on the same list runs before this. */
async function rollbackItemFiles(
  git: GitRunner,
  cwd: string,
  baseSha: string,
  files: readonly string[],
): Promise<void> {
  if (files.length === 0) return;
  const baseFiles = new Set((await git.lsTree(cwd, baseSha)).text().split("\n").filter(Boolean));
  const existing = files.filter((f) => baseFiles.has(f));
  const added = files.filter((f) => !baseFiles.has(f));
  if (existing.length > 0) await git.checkoutFiles(cwd, baseSha, existing);
  if (added.length > 0) await git.removeFiles(cwd, added);
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

function buildMultiItemPrompt(
  items: readonly LoopState["items"][string][],
  template: string,
  context?: { repoPath?: string; gitLog?: string },
): string {
  // The user prompt ALWAYS carries every item's facts: summary, source and
  // rejection note. The LOOP.md systemPrompt is only an extra behavioral
  // constraint (frozen into the Run as systemPrompt), so a template that
  // omits placeholders can never starve the agent of the items.
  const cores = items.map((item) => {
    let note = "";
    if (item.result && "reasons" in item.result) {
      note = `- 上次被拒原因: ${item.result.reasons.join("; ")}`;
    }
    return [
      `## Item ${item.id}`,
      `# Task\n${item.summary}`,
      `# Source\n${item.source}`,
      ...(note ? [note] : []),
    ].join("\n\n");
  });
  const ctx = context?.repoPath
    ? `\n\n## Project Context\n- Repo: ${context.repoPath}\n${context.gitLog ? `- Recent changes:\n${context.gitLog}\n` : ""}`
    : "";
  const extra = template.trim();
  return `${cores.join("\n\n---\n\n")}${extra ? `\n\n# Additional Instructions\n${extra}` : ""}${ctx}`;
}

export async function loopStep(params: LoopStepParams): Promise<LoopState> {
  return loopStepImpl(params);
}

async function loopStepImpl(params: LoopStepParams): Promise<LoopState> {
  const repoPath = await resolveRepoPath(params.loopConfigPath, params.projectPort, params.dataDir);

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

  const cwd = gitCwd!;

  const git = params.gitRunner ?? {
    revParse: (cwd: string) => Bun.$`git rev-parse HEAD`.cwd(cwd).quiet(),
    diff: (cwd: string, base: string, head: string) =>
      Bun.$`git diff --name-only ${base}..${head}`.cwd(cwd).quiet(),
    resetHard: (cwd: string, sha: string) =>
      Bun.$`git reset --hard ${sha}`.cwd(cwd).quiet().nothrow(),
    lsTree: (cwd: string, sha: string) => Bun.$`git ls-tree -r --name-only ${sha}`.cwd(cwd).quiet(),
    checkoutFiles: (cwd: string, sha: string, files: readonly string[]) =>
      Bun.$`git checkout ${sha} -- ${files}`.cwd(cwd).quiet().nothrow(),
    removeFiles: (cwd: string, files: readonly string[]) =>
      Bun.$`git rm -f ${files}`.cwd(cwd).quiet().nothrow(),
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

  // ── ONE generator run per step, covering ALL fixing items ──
  // The Loop seeds one workflow (meta = every fixing item); the generator
  // fans out per-item fix + self-verification and writes per-item verdicts
  // AND touchedFiles back into the meta. The product validates the whole
  // writeback and applies per-item transitions + selective rollback.
  if (fixingItems.length > 0) {
    const baseSha = (await git.revParse(cwd)).text().trim();
    const genConversationId = loopGeneratorConversationId(params.loopId);
    const genMemberId = loopGeneratorMemberId(params.loopId);
    await ensureLoopScope(params.convPort, genConversationId, genMemberId, "default");
    const gitLog = await Bun.$`git log --oneline -5`
      .cwd(cwd)
      .quiet()
      .text()
      .catch(() => "");
    await Bun.write(`${cwd}/.workflows/loop.js`, seedLoopWorkflowScript(fixingItems)).catch(
      () => {},
    );
    const genPromptFull = [
      buildMultiItemPrompt(fixingItems, genPrompt, { repoPath: cwd, gitLog }),
      `# Workflow\nThe script at .workflows/loop.js carries EVERY item's state in its meta block. ` +
        `Run it with the workflow_run tool (pass the script text). After the workflow completes, ` +
        `use the write tool to update the meta block in .workflows/loop.js: for each item set ` +
        `step (a legal transition), result (the verdict JSON from that item's verify agent), and ` +
        `touchedFiles (the JSON array of files that item's fix agent reported).`,
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
      idempotencyKey: `loop-gen:${params.loopId}:${baseSha}`,
      // LOOP.md generator systemPrompt is the frozen Run system prompt;
      // skills live in the loop config's skills/ dir + the builtin docs.
      systemPrompt: genPrompt || undefined,
      skillRoots: genSkillRoots,
      // Workspace is a Run execution fact: the Generator MUST run in the
      // cloned repo, not the loop-agent's own workspace.
      workspace: { root: cwd, access: "read_write" },
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
      // The previous attempt for this baseSha ended terminal without
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
        idempotencyKey: `loop-gen:${params.loopId}:${baseSha}:retry`,
        systemPrompt: genPrompt || undefined,
        skillRoots: genSkillRoots,
        workspace: { root: cwd, access: "read_write" },
        ...(dailyCap > 0 ? { workflowBudgetTokens: Math.max(0, dailyCap - spent) } : {}),
      });
      if (retry.acquired && retry.run) {
        genAcquire = { ...retry, replayed: false };
      }
    }
    if (!genAcquire.acquired || !genAcquire.run) {
      throw new Error(
        `loopStep: generator run could not acquire its branch (queued behind an active run)`,
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

    // ── Workflow verdicts: the script's meta carries every item's result ──
    const scriptText = await Bun.file(`${cwd}/.workflows/loop.js`)
      .text()
      .catch(() => "");
    const writtenMeta = extractLoopWorkflowMeta(scriptText);
    const seedMeta: LoopState = {
      loopId: params.loopId,
      lastRun: null,
      items: Object.fromEntries(fixingItems.map((i) => [i.id, i])),
    };
    const noVerdict = (reason: string): Verdict => ({
      verdict: "ESCALATE",
      reasons: [reason],
      evidence: "",
    });
    const validation = writtenMeta
      ? validateLoopMetaPatch(seedMeta, writtenMeta)
      : { ok: false as const, reason: "workflow script has no parseable meta block" };

    for (const item of fixingItems) {
      state = loopReducer(state, {
        type: "GENERATOR_DONE",
        itemId: item.id,
        generatorRunId,
      });

      const writtenItem = writtenMeta?.items[item.id];
      const rawTouched = (writtenItem as { touchedFiles?: unknown } | undefined)?.touchedFiles;
      const touchedFiles = Array.isArray(rawTouched)
        ? rawTouched.filter((f): f is string => typeof f === "string")
        : [];
      const violations = denylistedFiles(touchedFiles, denylist);
      let verdict: Verdict;
      if (violations.length > 0) {
        verdict = {
          verdict: "REJECT",
          reasons: [`修改了 denylist 保护路径: ${violations.join(", ")}`],
          evidence: "denylist check (pre-verifier)",
        };
      } else if (!validation.ok) {
        verdict = noVerdict(`workflow meta writeback invalid: ${validation.reason}`);
      } else {
        verdict = writtenItem?.result ?? noVerdict(`workflow wrote no verdict for ${item.id}`);
      }
      state = loopReducer(state, {
        type: "EVALUATOR_VERDICT",
        itemId: item.id,
        verdict,
      });

      // Selective rollback on REJECT/ESCALATE: revert THIS item's files
      // (PASS items keep their changes in the shared clone).
      const updatedItem = state.items[item.id];
      if (updatedItem && (updatedItem.step === "fixing" || updatedItem.step === "inbox")) {
        if (touchedFiles.length > 0) {
          await rollbackItemFiles(git, cwd, baseSha, touchedFiles);
        } else {
          // No attribution available: conservative whole-tree reset.
          await git.resetHard(cwd, baseSha);
        }
      }
    }
  }

  // 4. Write back
  params.store.save(params.loopId, state, inboxItems);
  return state;
}
