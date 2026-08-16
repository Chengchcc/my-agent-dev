# Project Worktree P2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Loops run in per-agent git worktrees (per-step clone retired) and the project aggregate page shows branch status/diff with in-page fast-forward/merge.

**Architecture:** LOOP.md gains a top-level `agent` field (default "default"); `resolveLoopWorktree` replaces `resolveRepoPath` by reusing P1's `ensureMirror`/`ensureWorktree` plus a per-step `reset --hard` to the default branch. Merge ops (`worktree-ops.ts`) run entirely inside the bare mirror (rev-list / merge-tree / branch -f plumbing — never touching live worktrees), with optional push. The web project page becomes an aggregate: worktree cards with ahead/behind, diff, FF/Merge actions.

**Tech Stack:** Bun 1.3 + `Bun.$` git plumbing, packages/loop config parser (zod-free YAML frontmatter), Elysia HTTP, Next.js 15 + existing polish atoms, bun:test with real git fixtures.

**Spec:** `docs/superpowers/specs/2026-08-14-project-worktree-p2-design.md`

**Hard rules from repo/session:**
- commitlint: scope in parentheses, no CJK, body lines ≤100 chars.
- No `as unknown as` (test-double boundary exception only); no python/sed to edit source — read+edit.
- Real wall-clock waits in tests are forbidden (`ts-no-test-timers`); poll awaited conditions instead.
- Loop package is source-only (no build); backend rebuilds after `packages/loop` changes are not needed — but run `bun run build --filter=@my-agent-team/loop` is NOT a script; just typecheck.

---

## Task 1: LoopConfig `agent` field

**Files:**
- Modify: `packages/loop/src/state-md.ts` (LoopConfig + parseLoopConfig)
- Modify: `apps/backend/src/features/loop/loop-service.ts` (writeDefaultLoopMd + create input)
- Modify: `apps/backend/src/features/loop/http.ts` (create body)
- Test: `packages/loop/src/state-md.test.ts` (extend)

- [ ] **Step 1: Failing test**

```typescript
test("parseLoopConfig reads the agent field with default back-compat", () => {
  const withAgent = parseLoopConfig(LOOP_MD_HEADER + "\nagent: coder-1\n" + LOOP_MD_BODY);
  expect(withAgent?.agent).toBe("coder-1");
  const without = parseLoopConfig(LOOP_MD_HEADER + "\n" + LOOP_MD_BODY);
  expect(without?.agent).toBe("default");
});
```

Adapt `LOOP_MD_HEADER`/`LOOP_MD_BODY` to the test file's existing LOOP.md fixture style (a minimal frontmatter with projectId + differing generator/evaluator models). If the file uses inline strings, write the full minimal doc inline.

- [ ] **Step 2: Run, expect failure**

Run: `cd packages/loop && bun test src/state-md.test.ts`
Expected: FAIL — `agent` does not exist on LoopConfig.

- [ ] **Step 3: Implement**

`state-md.ts`:

```typescript
export interface LoopConfig {
  projectId: string;
  /** The agent whose (agent, project) worktree runs this loop's steps
   *  (ADR 0023 P2). Empty string = "default" (back-compat). */
  agent: string;
  // ...rest unchanged
}
```

In `parseLoopConfig`'s return object add:
```typescript
    agent: String(frontmatter.agent ?? "default") || "default",
```

`loop-service.ts` `writeDefaultLoopMd`: add `agent: string | undefined` to the signature; emit after projectId:
```typescript
      `projectId: ${projectId ?? ""}`,
      `agent: ${agent ?? "default"}`,
```
Call sites (loop-service.ts:217 and ~245): pass `input.agent` (create path) and `undefined` (default path). Add `agent?: string` to the create input type (near `projectId?: string`, line ~153).

`loop/http.ts` create body (~line 95): `agent: t.Optional(t.String({ minLength: 1 })),` and pass through to the service call (~line 84: `agent: body.agent,`).

- [ ] **Step 4: Verify + commit**

Run: `cd packages/loop && bun test && cd ../../apps/backend && bunx tsc --noEmit -p tsconfig.test.json`
Expected: pass, clean.

```bash
git add packages/loop/src/state-md.ts packages/loop/src/state-md.test.ts apps/backend/src/features/loop/loop-service.ts apps/backend/src/features/loop/http.ts
git commit -m "feat(loop): LOOP.md agent field - which agent's worktree runs the loop"
```

---

## Task 2: resolveLoopWorktree replaces the per-step clone

**Files:**
- Modify: `apps/backend/src/features/loop/loop-step.ts` (resolveRepoPath → resolveLoopWorktree; ensureLoopScope routing)
- Modify: `apps/backend/src/features/loop/loop-step.test.ts` (fixtures)
- Modify: `apps/backend/src/features/cron/scheduler.ts` + `apps/backend/src/features/loop/loop-service.ts` + `apps/backend/src/features/loop/http.ts` (params plumbing)
- Modify: `apps/backend/src/bootstrap/features.ts` (wire agentWorkspaceOf)

- [ ] **Step 1: Replace the resolver**

In `loop-step.ts`, delete `resolveRepoPath` (lines 114-152) and add:

```typescript
/** Resolve the loop agent's (agent, project) worktree and hard-reset it to
 *  the project's default branch — the per-step clean start (ADR 0023 P2;
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
  const branch = project.defaultBranch ?? "HEAD";
  await Bun.$`git -C ${wt} reset --hard ${branch === "HEAD" ? "refs/remotes/origin/HEAD" : `refs/heads/${branch}`}`.quiet();
  return wt;
}
```

Import `ensureMirror, ensureWorktree` from `../project/worktree.js`. Replace the call site in `loopStepImpl` (line ~249):

```typescript
  const cwd = await resolveLoopWorktree(params.loopConfigPath, {
    projectPort: params.projectPort,
    dataDir: params.dataDir,
    agentWorkspaceOf: params.agentWorkspaceOf,
  });
```

(The old binding was `const repoPath = ...` then `cwd` came from it — read the current lines 249-260 and keep whatever else used `repoPath` pointing at `cwd`.) Rename the variable so every later `cwd` use is untouched.

Add to `LoopStepParams`:

```typescript
  /** Resolve a LOOP.md agent id to its workspace path (null = unknown
   *  agent). Wired from the composition root via agentSvc. */
  agentWorkspaceOf: (agentId: string) => Promise<string | null>;
```

- [ ] **Step 2: ensureLoopScope routing**

Line ~390: `ensureLoopScope(params.convPort, genConversationId, genMemberId, "default")` → read `cfg` first (it is parsed later at the moment — hoist the LOOP.md parse above the scope creation, or re-read cheaply):

```typescript
    await ensureLoopScope(params.convPort, genConversationId, genMemberId, cfg.agent || "default");
```

Check the evaluator's `ensureLoopScope` call too — same change.

- [ ] **Step 3: Plumbing**

- `scheduler.ts` fireLoop params: add `agentWorkspaceOf: deps.agentWorkspaceOf,` and add the dep to `createCronScheduler`'s deps interface: `agentWorkspaceOf: (agentId: string) => Promise<string | null>;`
- `loop-service.ts` `runLoop` deps + the `loopStepDeps` object in `http.ts`: same field.
- `bootstrap/features.ts`: `createCronScheduler({...})` gains:
  ```typescript
    agentWorkspaceOf: async (id: string) => {
      const agent = await agentSvc.getById(id).catch(() => null);
      return agent?.workspacePath ?? null;
    },
  ```
  and the same object into the loop http wiring (find where `loopStepDeps` gets its deps in features.ts — search `loopRoutes(`).

- [ ] **Step 4: Test fixtures**

In `loop-step.test.ts`, the tests that exercise repo behavior build a fixture repo and (currently) rely on the clone path. Update:
- Provide `agentWorkspaceOf: async () => <loopAgentWs>` (a tmp dir) in the params objects.
- After the step, assert the run's workspace root is `join(loopAgentWs, "projects", <projectId>)` (the worktree), not `dataDir/repos/...`.
- Any literal `repos/` path expectations are deleted.
- `git reset --hard` in the resolver runs against the real fixture repo — the existing GitRunner mock only covers rollback calls; the resolver's own git is real Bun.$ (same as the old clone path was).

- [ ] **Step 5: Verify + commit**

Run: `cd apps/backend && bun test src/features/loop/ && bunx tsc --noEmit -p tsconfig.test.json`
Expected: pass, clean. Then `grep -rn "resolveRepoPath\|dataDir/repos" apps/backend/src --include="*.ts"` → zero hits outside the bootstrap info note (add one `console.info` in features.ts near the scheduler wiring: legacy `dataDir/repos` clones are no longer read and may be deleted manually — cite the path).

```bash
git add apps/backend/src packages/loop/src
git commit -m "feat(loop): loop steps run in the agent worktree, per-step clone retired"
```

---

## Task 3: worktree-ops (status/diff/fast-forward/merge)

**Files:**
- Create: `apps/backend/src/features/project/worktree-ops.ts`
- Test: `apps/backend/src/features/project/worktree-ops.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeOps, type WorktreeStatus } from "./worktree-ops.js";
import type { ProjectPort } from "./ports.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** source repo: main + one commit; returns repo path. */
async function makeSource(dir: string, extraCommitOnMain = false): Promise<string> {
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  await Bun.$`git init -b main ${src}`.quiet();
  await Bun.$`git -C ${src} config user.email t@t`.quiet();
  await Bun.$`git -C ${src} config user.name t`.quiet();
  await Bun.$`echo base > ${join(src, "F.txt")}`.quiet();
  await Bun.$`git -C ${src} add -A && git -C ${src} commit -m base`.quiet();
  if (extraCommitOnMain) {
    await Bun.$`echo main2 > ${join(src, "G.txt")}`.quiet();
    await Bun.$`git -C ${src} add -A && git -C ${src} commit -m main2`.quiet();
  }
  return src;
}

function fakeProjectPort(repoUrl: string, projectId: string): ProjectPort {
  return {
    createProject: () => {
      throw new Error("unused");
    },
    getProject: (id: string) =>
      id === projectId
        ? {
            projectId,
            name: "p",
            repoUrl,
            defaultBranch: "main",
            createdAt: 0,
            updatedAt: 0,
          }
        : null,
    listProjects: () => [],
    updateProject: () => null,
    deleteProject: () => false,
  } as unknown as ProjectPort;
}

const PID = "pp";

describe("worktree ops", () => {
  test("status counts ahead/behind; fast-forward moves base; divergence refused; conflicts 409", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wops-"));
    dirs.push(dir);
    const src = await makeSource(dir);
    const dataDir = join(dir, "data");
    const agentWs = join(dir, "agent");
    mkdirSync(agentWs, { recursive: true });

    // Materialize the worktree via the P1 plumbing (setup, not under test).
    const { ensureMirror, ensureWorktree } = await import("./worktree.js");
    const mirror = await ensureMirror(dataDir, {
      projectId: PID,
      repoUrl: src,
      defaultBranch: "main",
    });
    await ensureWorktree(
      mirror,
      agentWs,
      { projectId: PID, repoUrl: src, defaultBranch: "main" },
      "a1",
    );
    // A commit on the agent branch (work directly in the mirror: plumbing).
    const wt = join(agentWs, "projects", PID);
    await Bun.$`echo work > ${join(wt, "W.txt")}`.quiet();
    await Bun.$`git -C ${wt} add -A && git -C ${wt} -c user.email=t@t -c user.name=t commit -m w`.quiet();

    const ops = createWorktreeOps({
      dataDir,
      projectPort: fakeProjectPort(src, PID),
      listAgentConfigs: async () => [{ id: "a1", workspacePath: agentWs, projects: [PID] }],
    });

    const st = await ops.status(PID);
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ agentId: "a1", ahead: 1, behind: 0, worktreeReady: true });

    const diff = await ops.diff(PID, "a1");
    expect(diff).toContain("W.txt");

    await ops.fastForward(PID, "a1", { push: false });
    const st2 = await ops.status(PID);
    expect(st2[0]?.ahead).toBe(0);

    // Divergence: new commit on main + new commit on agent branch.
    await Bun.$`git -C ${src} -c user.email=t@t -c user.name=t commit --allow-empty -m m2`.quiet();
    await Bun.$`git -C ${mirror} fetch --prune origin`.quiet();
    await Bun.$`git -C ${wt} -c user.email=t@t -c user.name=t commit --allow-empty -m w2`.quiet();
    await expect(ops.fastForward(PID, "a1", { push: false })).rejects.toThrow(/diverged/);
  }, 20_000);

  test("merge with conflicting changes reports the conflict files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wops2-"));
    dirs.push(dir);
    const src = await makeSource(dir);
    const dataDir = join(dir, "data");
    const agentWs = join(dir, "agent");
    mkdirSync(agentWs, { recursive: true });
    const { ensureMirror, ensureWorktree } = await import("./worktree.js");
    const mirror = await ensureMirror(dataDir, {
      projectId: PID,
      repoUrl: src,
      defaultBranch: "main",
    });
    const wt = await ensureWorktree(
      mirror,
      agentWs,
      { projectId: PID, repoUrl: src, defaultBranch: "main" },
      "a1",
    );
    if (!wt) throw new Error("worktree setup failed");
    // Agent edits F.txt; main also edits F.txt -> conflict.
    await Bun.$`echo agent > ${join(wt, "F.txt")}`.quiet();
    await Bun.$`git -C ${wt} add -A && git -C ${wt} -c user.email=t@t -c user.name=t commit -m a`.quiet();
    await Bun.$`git -C ${src} echo main > ${join(src, "F.txt")}`.quiet();
    await Bun.$`git -C ${src} add -A && git -C ${src} -c user.email=t@t -c user.name=t commit -m m`.quiet();
    await Bun.$`git -C ${mirror} fetch --prune origin`.quiet();

    const ops = createWorktreeOps({
      dataDir,
      projectPort: fakeProjectPort(src, PID),
      listAgentConfigs: async () => [{ id: "a1", workspacePath: agentWs, projects: [PID] }],
    });
    await expect(ops.merge(PID, "a1", { push: false })).rejects.toThrow(/F\.txt/);
  }, 20_000);
});
```

NOTE: `git -C ${src} echo main > ...` is wrong — the implementer must write it as `await Bun.$`echo main > ${join(src, "F.txt")}`.quiet();` (the redirect is shell-level). Fix while typing; the intent is: source file changed on main.

- [ ] **Step 2: Run, expect failure**

Run: `cd apps/backend && bun test src/features/project/worktree-ops.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConflictError } from "../../infra/domain-errors.js";
import type { ProjectPort } from "./ports.js";
import { ensureMirror } from "./worktree.js";

export interface WorktreeStatus {
  agentId: string;
  branch: string;
  ahead: number;
  behind: number;
  worktreeReady: boolean;
}

export interface WorktreeOps {
  status(projectId: string): Promise<WorktreeStatus[]>;
  diff(projectId: string, agentId: string): Promise<string>;
  fastForward(projectId: string, agentId: string, opts: { push: boolean }): Promise<void>;
  merge(projectId: string, agentId: string, opts: { push: boolean }): Promise<void>;
}

/** Read/merge operations over a project's agent worktrees. All git runs in
 *  the bare mirror (plumbing) — never in a live worktree (a run may hold
 *  it). Base moves are branch -f only; two-sided merges are refused (see
 *  the spec's honest boundary). */
export function createWorktreeOps(deps: {
  dataDir: string;
  projectPort: ProjectPort;
  listAgentConfigs: () => Promise<Array<{ id: string; workspacePath: string; projects: string[] }>>;
}): WorktreeOps {
  const mirrorOf = async (projectId: string): Promise<string> => {
    const project = deps.projectPort.getProject(projectId);
    if (!project?.repoUrl) throw new Error(`project ${projectId} has no repoUrl`);
    return ensureMirror(deps.dataDir, {
      projectId: project.projectId,
      repoUrl: project.repoUrl,
      defaultBranch: project.defaultBranch,
    });
  };

  const baseRef = async (projectId: string): Promise<string> => {
    const project = deps.projectPort.getProject(projectId);
    return project?.defaultBranch ?? "origin/HEAD";
  };

  const pushBase = async (mirror: string, base: string): Promise<void> => {
    const res = await Bun.$`git -C ${mirror} push origin ${base}`.quiet().nothrow();
    if (res.exitCode !== 0) {
      throw new Error(`push failed: ${res.stderr.toString().slice(0, 200)}`);
    }
  };

  return {
    async status(projectId) {
      const mirror = await mirrorOf(projectId);
      const base = await baseRef(projectId);
      const agents = (await deps.listAgentConfigs()).filter((a) => a.projects.includes(projectId));
      const out: WorktreeStatus[] = [];
      for (const a of agents) {
        const branch = `agent/${a.id}/${projectId}`;
        const has =
          (await Bun.$`git -C ${mirror} show-ref --verify refs/heads/${branch}`.quiet().nothrow())
            .exitCode === 0;
        if (!has) continue;
        const counts = await Bun.$`git -C ${mirror} rev-list --left-right --count ${base}...${branch}`
          .quiet()
          .text();
        const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
        out.push({
          agentId: a.id,
          branch,
          ahead: ahead ?? 0,
          behind: behind ?? 0,
          worktreeReady: existsSync(join(a.workspacePath, "projects", projectId)),
        });
      }
      return out;
    },

    async diff(projectId, agentId) {
      const mirror = await mirrorOf(projectId);
      const base = await baseRef(projectId);
      return Bun.$`git -C ${mirror} diff ${base}...agent/${agentId}/${projectId}`.quiet().text();
    },

    async fastForward(projectId, agentId, opts) {
      const mirror = await mirrorOf(projectId);
      const base = await baseRef(projectId);
      const branch = `agent/${agentId}/${projectId}`;
      const counts = await Bun.$`git -C ${mirror} rev-list --left-right --count ${base}...${branch}`
        .quiet()
        .text();
      const [behind] = counts.trim().split(/\s+/).map(Number);
      if ((behind ?? 0) > 0) {
        throw new ConflictError(`fast-forward refused: ${base} diverged from ${branch}`);
      }
      await Bun.$`git -C ${mirror} branch -f ${base} ${branch}`.quiet();
      if (opts.push) await pushBase(mirror, base);
    },

    async merge(projectId, agentId, opts) {
      const mirror = await mirrorOf(projectId);
      const base = await baseRef(projectId);
      const branch = `agent/${agentId}/${projectId}`;
      // merge-tree preflight: conflict markers appear as changed lines.
      const tree = await Bun.$`git -C ${mirror} merge-tree --write-tree ${base} ${branch}`
        .quiet()
        .nothrow();
      const text = tree.text();
      if (tree.exitCode !== 0 || text.includes("<<<<<<<")) {
        const files = text
          .split("\n")
          .filter((l) => l && !l.startsWith("-") && !l.startsWith("+"))
          .slice(1, 11)
          .join(", ");
        throw new ConflictError(`merge conflicts: ${files || "see merge-tree output"}`);
      }
      const counts = await Bun.$`git -C ${mirror} rev-list --left-right --count ${base}...${branch}`
        .quiet()
        .text();
      const [behind] = counts.trim().split(/\s+/).map(Number);
      if ((behind ?? 0) > 0) {
        throw new ConflictError(
          `diverged; merge both branches manually (base has commits not on agent/${agentId})`,
        );
      }
      await Bun.$`git -C ${mirror} branch -f ${base} ${branch}`.quiet();
      if (opts.push) await pushBase(mirror, base);
    },
  };
}
```

The `merge-tree --write-tree` flag exists in git ≥ 2.38 (box has 2.39). If the parse proves brittle, the fallback is `git merge-tree <base> <branch>` (old form) and grep for `changed in both` — implement what passes the test honestly.

- [ ] **Step 4: Verify + commit**

Run: `cd apps/backend && bun test src/features/project/`
Expected: all pass (worktree + ops suites).

```bash
git add apps/backend/src/features/project/worktree-ops.ts apps/backend/src/features/project/worktree-ops.test.ts
git commit -m "feat(backend): worktree ops - status, diff, fast-forward, merge in the mirror"
```

---

## Task 4: HTTP endpoints

**Files:**
- Modify: `apps/backend/src/features/project/http.ts`
- Modify: `apps/backend/src/bootstrap/features.ts` (wire ops)
- Test: extend `apps/backend/src/features/project/http.test.ts`

- [ ] **Step 1: Routes**

`projectRoutes` gains an optional `worktreeOps?: WorktreeOps` param; when absent the routes 501 (keeps http.test.ts standalone):

```typescript
    .get("/api/projects/:id/worktrees", async ({ params: { id } }) => {
      if (!worktreeOps) return Response.json({ error: "worktree ops unavailable" }, { status: 501 });
      return { worktrees: await worktreeOps.status(id) };
    })
    .get("/api/projects/:id/worktrees/:agentId/diff", async ({ params: { id, agentId } }) => {
      if (!worktreeOps) return Response.json({ error: "worktree ops unavailable" }, { status: 501 });
      return { diff: await worktreeOps.diff(id, agentId) };
    })
    .post(
      "/api/projects/:id/worktrees/:agentId/fast-forward",
      async ({ params: { id, agentId }, body }) => {
        if (!worktreeOps) return Response.json({ error: "worktree ops unavailable" }, { status: 501 });
        await worktreeOps.fastForward(id, agentId, { push: body.push === true });
        return { ok: true };
      },
      { body: t.Object({ push: t.Optional(t.Boolean()) }) },
    )
    .post(
      "/api/projects/:id/worktrees/:agentId/merge",
      async ({ params: { id, agentId }, body }) => {
        if (!worktreeOps) return Response.json({ error: "worktree ops unavailable" }, { status: 501 });
        await worktreeOps.merge(id, agentId, { push: body.push === true });
        return { ok: true };
      },
      { body: t.Object({ push: t.Optional(t.Boolean()) }) },
    )
```

ConflictError must map to 409 in the shared catch (the delete route already does — extract or duplicate the mapping for these four routes).

- [ ] **Step 2: Bootstrap wiring**

`features.ts`:

```typescript
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
```

Pass into `projectRoutes(projectSvc, worktreeOps)`.

- [ ] **Step 3: Test**

One happy-path test in http.test.ts: a project + attached agent + real repo through the ops (reuse the worktree-ops fixture pattern); GET worktrees returns the status row. A 409 test: call fast-forward on a diverged setup, expect 409 + `diverged` in the body. Keep it lean — the ops logic is covered by Task 3.

- [ ] **Step 4: Verify + commit**

Run: `cd apps/backend && bun test src/features/project/ && bunx tsc --noEmit -p tsconfig.test.json`
Expected: pass, clean.

```bash
git add apps/backend/src/features/project/http.ts apps/backend/src/features/project/http.test.ts apps/backend/src/bootstrap/features.ts
git commit -m "feat(backend): project worktree http endpoints - status/diff/ff/merge"
```

---

## Task 5: Aggregate page

**Files:**
- Create: `apps/web/src/app/(main)/team/projects/[id]/page.tsx`
- Create: `apps/web/src/app/(main)/team/projects/_components/worktree-card.tsx`
- Modify: `apps/web/src/lib/api.ts` (four endpoints + types)
- Modify: `apps/web/src/app/(main)/team/projects/page.tsx` (row link + agents badge)
- Modify: `apps/web/scripts/ui-audit.ts` (one assertion)

- [ ] **Step 1: api.ts**

```typescript
  listProjectWorktrees: (id: string) =>
    unwrap(client.api.projects({ id }).worktrees.get()),
  projectWorktreeDiff: (id: string, agentId: string) =>
    unwrap(client.api.projects({ id }).worktrees({ agentId }).diff.get()),
  projectWorktreeFastForward: (id: string, agentId: string, push: boolean) =>
    unwrap(client.api.projects({ id }).worktrees({ agentId })["fast-forward"].post({ push })),
  projectWorktreeMerge: (id: string, agentId: string, push: boolean) =>
    unwrap(client.api.projects({ id }).worktrees({ agentId }).merge.post({ push })),
```

Type derives from the backend App via Eden (no hand-written types needed).

- [ ] **Step 2: Aggregate page**

`[id]/page.tsx` (client component; read an existing detail page for the Page/PageHeader pattern):

- `PageHeader` with project name (query `api.getProject`-equivalent — the list endpoint filtered by id is fine; add `getProject` back to api.ts if absent).
- Loops section: existing `useLoops()`-style query filtered by `projectId` (loop rows expose projectId? — check the loop list API; if not exposed, filter client-side by the LOOP.md data the loop detail carries; worst case show all loops with a note. Do not change the backend for this).
- Worktrees section: `api.listProjectWorktrees(id)` → one `WorktreeCard` per row (empty → EmptyState pointing at agent detail).

`worktree-card.tsx`:

```tsx
"use client";
// ListRowCard shell: agent id, branch mono chip, ahead/behind badges
// (ahead>0 = ok tone), worktreeReady warning, expandable diff (first 200
// lines), FF + Merge buttons behind window.confirm with a push checkbox.
```

Behaviors: expand lazily fetches the diff once (React state toggle); FF/Merge POST then `invalidateQueries(["project-worktrees", id])`; error toasts carry the backend message (409 diverged surfaces verbatim).

- [ ] **Step 3: Projects list row**

`projects/page.tsx`: row gains an onClick → `/team/projects/<id>` and an `N agents` badge (derive from `useQuery(["agents"])` filtering `a.projects?.includes(id)`).

- [ ] **Step 4: Audit assertion**

In `ui-audit.ts` append:

```typescript
  {
    name: "P3-project-detail has a worktree card container",
    check: async () =>
      withPage("/team/projects", async (page) => {
        await loginIfNeeded(page);
        // Navigate into the first project if the list has one.
        const has = await page.evaluate(() =>
          Boolean(document.querySelector('[data-testid="project-worktrees"]')),
        );
        // Detail-only container: the list page not having it is fine; open
        // the first row when present.
        const first = await page.$("a[href^='/team/projects/']");
        if (first) {
          await first.click();
          await page.waitForSelector('[data-testid="project-worktrees"]', { timeout: 15_000 });
          return;
        }
        if (!has) throw new Error("no projects to audit");
      }),
  },
```

Adjust selector to the actual link markup; the assertion passes when either the empty state renders or a card container appears after navigation.

- [ ] **Step 5: Verify + commit**

Run: `cd apps/web && bunx tsc --noEmit -p tsconfig.json && bun test`
Expected: clean, pass.

```bash
git add apps/web/src apps/web/scripts/ui-audit.ts
git commit -m "feat(web): project aggregate page - worktree cards, diff, ff/merge"
```

---

## Task 6: Full gates + live E2E + close

**Files:**
- Modify: `docs/superpowers/specs/2026-08-14-project-worktree-p2-design.md` (check §7 boxes)

- [ ] **Step 1: Full gates**

Run: `cd /root/my-agent-team && bun run typecheck && bun run lint && bun run test`
Expected: all green.

- [ ] **Step 2: Live E2E (local file:// repo)**

1. Restart backend; reuse or recreate the demo project from P1's smoke.
2. Create a LOOP.md (via the loop create API with `agent: default` + projectId) — or hand-write `.loop` config; simplest: POST /api/loops with projectId and agent.
3. Trigger one loop step (POST /api/loops/:id/run) — with no real model the run fails at preflight; that's fine: assert the **worktree was materialized and reset** (mtime/content of `<agentWs>/projects/<pid>`) and the failure reason is model-availability, not worktree.
4. Aggregate page: open `/team/projects/<id>` in the built web; make a commit on the agent branch manually (`git -C <wt> commit --allow-empty`); verify ahead badge = 1; run FF via the page; verify ahead → 0 and (with push off) no network push attempted.

- [ ] **Step 3: Acceptance sweep**

- `grep -rn "resolveRepoPath\|dataDir/repos" apps/backend/src --include="*.ts"` → only the bootstrap info note.
- Spec §7 boxes all checked.

- [ ] **Step 4: Commit + push**

```bash
git add docs/superpowers/specs/2026-08-14-project-worktree-p2-design.md
git commit -m "docs(docs): project worktree P2 acceptance verified"
git push
```
