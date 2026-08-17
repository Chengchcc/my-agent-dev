# Project Worktree P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent↔Project many-to-many via git worktrees: agent.yml declares `projects`, reconcile materializes a worktree per (agent, project) with bridged config, and conversations bound to a project run with cwd = worktree while context stays in the agent workspace.

**Architecture:** A new `worktree.ts` in features/project owns git plumbing (mirror + worktree + branch, all idempotent). The agent config schema gains `runtime_config.projects` (file-first, PATCH-validated). Reconcile extends to materialize worktrees and bridge `.mcp.json`/product-tools into them. `resolveWorkspace` maps conversation.projectId → worktree path (explicit failure when not attached). Migration 0032 adds `conversation.project_id` and drops the dead `auto_orchestrate`.

**Tech Stack:** Bun 1.3 + `Bun.$` git shellouts, drizzle SQLite (hand-written migration), zod config schema, Elysia HTTP, bun:test with real git fixtures.

**Spec:** `docs/superpowers/specs/2026-08-14-project-worktree-p1-design.md` · **ADR:** `docs/adr/0023-project-worktree-workspace.md`

**Hard rules from repo/session:**
- commitlint: scope in parentheses, no CJK, body lines ≤100 chars.
- No `as unknown as` (test-double boundary exception only); no python/sed to edit source — read+edit.
- Hand-written migrations: multi-statement files MUST use `--> statement-breakpoint` separators; `when` strictly increasing (0031 = 1786606000000, use a later value).
- After touching packages' public types: `bun run build --filter=<pkg>` before apps typecheck.

---

## Task 1: `worktree.ts` — git plumbing

**Files:**
- Create: `apps/backend/src/features/project/worktree.ts`
- Test: `apps/backend/src/features/project/worktree.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMirror, ensureWorktree, removeWorktree } from "./worktree.js";

/** Build a real source repo with one commit on main. */
async function makeSourceRepo(dir: string): Promise<string> {
  const src = join(dir, "src-repo");
  mkdirSync(src, { recursive: true });
  await Bun.$`git init -b main ${src}`.quiet();
  await Bun.$`git -C ${src} config user.email t@t`.quiet();
  await Bun.$`git -C ${src} config user.name t`.quiet();
  await Bun.$`echo hello > ${join(src, "README.md")}`.quiet();
  await Bun.$`git -C ${src} add -A`.quiet();
  await Bun.$`git -C ${src} commit -m init`.quiet();
  return src;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const PROJECT = { projectId: "p1", repoUrl: "", defaultBranch: "main" };

describe("project worktree", () => {
  test("mirror + worktree materialize idempotently; detach cleans up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-"));
    dirs.push(dir);
    const src = await makeSourceRepo(dir);
    const dataDir = join(dir, "data");
    const agentWs = join(dir, "agent-ws");
    mkdirSync(agentWs, { recursive: true });

    const mirror = await ensureMirror(dataDir, { ...PROJECT, repoUrl: src });
    expect(existsSync(join(mirror, "HEAD"))).toBe(true);
    // Second run is a fetch, not a re-clone; still fine.
    await ensureMirror(dataDir, { ...PROJECT, repoUrl: src });

    const wt = await ensureWorktree(mirror, agentWs, { ...PROJECT, repoUrl: src }, "agent-1");
    expect(existsSync(join(wt, "README.md"))).toBe(true);
    const branch = await Bun.$`git -C ${wt} rev-parse --abbrev-ref HEAD`.text();
    expect(branch.trim()).toBe("agent/agent-1/p1");
    // Idempotent: same path, no error.
    const wt2 = await ensureWorktree(mirror, agentWs, { ...PROJECT, repoUrl: src }, "agent-1");
    expect(wt2).toBe(wt);

    await removeWorktree(mirror, agentWs, { ...PROJECT, repoUrl: src }, "agent-1");
    expect(existsSync(wt)).toBe(false);
  });

  test("occupied worktree slot returns null (user dir never clobbered)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt2-"));
    dirs.push(dir);
    const src = await makeSourceRepo(dir);
    const agentWs = join(dir, "agent-ws");
    const slot = join(agentWs, "projects", "p1");
    mkdirSync(slot, { recursive: true });
    await Bun.$`echo mine > ${join(slot, "KEEP")}`.quiet();

    const mirror = await ensureMirror(join(dir, "data"), { ...PROJECT, repoUrl: src });
    const wt = await ensureWorktree(mirror, agentWs, { ...PROJECT, repoUrl: src }, "agent-1");
    expect(wt).toBeNull();
    expect(await Bun.$`cat ${join(slot, "KEEP")}`.text()).toContain("mine");
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `cd apps/backend && bun test src/features/project/worktree.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Project facts the worktree plumbing needs (subset of ProjectRow). */
export interface WorktreeProject {
  readonly projectId: string;
  readonly repoUrl: string;
  readonly defaultBranch: string | null;
}

function worktreePath(agentWorkspace: string, projectId: string): string {
  return join(agentWorkspace, "projects", projectId);
}

function branchName(agentId: string, projectId: string): string {
  return `agent/${agentId}/${projectId}`;
}

/** Ensure the shared bare mirror exists and is fresh. Clone writes to
 *  `<id>.git.tmp` then renames; a stale tmp from a crashed clone is
 *  removed first. Returns the mirror path. */
export async function ensureMirror(
  dataDir: string,
  project: WorktreeProject,
): Promise<string> {
  const mirror = join(dataDir, "projects", `${project.projectId}.git`);
  const tmp = `${mirror}.tmp`;
  mkdirSync(join(dataDir, "projects"), { recursive: true });
  if (existsSync(mirror)) {
    await Bun.$`git -C ${mirror} fetch --prune origin`.quiet();
    return mirror;
  }
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  await Bun.$`git clone --mirror ${project.repoUrl} ${tmp}`.quiet();
  renameSync(tmp, mirror);
  return mirror;
}

/** Ensure the agent's worktree exists on its own branch. Returns the
 *  worktree path, or null when the slot is occupied by a non-worktree
 *  directory (user's own files — never clobbered). */
export async function ensureWorktree(
  mirrorPath: string,
  agentWorkspace: string,
  project: WorktreeProject,
  agentId: string,
): Promise<string | null> {
  const wt = worktreePath(agentWorkspace, project.projectId);
  const listed = await Bun.$`git -C ${mirrorPath} worktree list --porcelain`.text();
  if (listed.includes(wt)) return wt;
  if (existsSync(wt)) return null; // occupied by a plain directory
  const branch = branchName(agentId, project.projectId);
  const base = project.defaultBranch ?? `refs/heads/$(git -C ${mirrorPath} symbolic-ref HEAD)`.slice(0, 0) || "HEAD";
  const hasBranch =
    (await Bun.$`git -C ${mirrorPath} show-ref --verify refs/heads/${branch}`.quiet().nothrow())
      .exitCode === 0;
  const ref = hasBranch ? branch : `-b ${branch}`;
  const target = project.defaultBranch ?? (hasBranch ? "" : "HEAD");
  mkdirSync(join(agentWorkspace, "projects"), { recursive: true });
  await Bun.$`git -C ${mirrorPath} worktree add ${ref} ${wt} ${target}`.quiet();
  return wt;
}

/** Detach the worktree and delete its branch. */
export async function removeWorktree(
  mirrorPath: string,
  agentWorkspace: string,
  project: WorktreeProject,
  agentId: string,
): Promise<void> {
  const wt = worktreePath(agentWorkspace, project.projectId);
  await Bun.$`git -C ${mirrorPath} worktree remove --force ${wt}`.quiet().nothrow();
  await Bun.$`git -C ${mirrorPath} branch -D ${branchName(agentId, project.projectId)}`
    .quiet()
    .nothrow();
}
```

NOTE for the implementer: the `base` line above is deliberately suspicious — clean it up while implementing: the correct logic is
`const target = project.defaultBranch ?? "HEAD";` and `ref = hasBranch ? branch : `-b ${branch}``, then `worktree add ${ref} ${wt} ${hasBranch ? "" : target}`. Write the final version plainly; do not keep dead code.

- [ ] **Step 4: Run, expect pass**

Run: `cd apps/backend && bun test src/features/project/worktree.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/features/project/worktree.ts apps/backend/src/features/project/worktree.test.ts
git commit -m "feat(backend): project worktree git plumbing - mirror + worktree + branch"
```

---

## Task 2: agent.yml `projects` field

**Files:**
- Modify: `apps/backend/src/features/agent/agent-config.ts`
- Modify: `apps/backend/src/features/agent/service.ts` (buildAgentConfig input)
- Modify: `apps/backend/src/features/agent/http.ts` (PATCH body + response)
- Test: extend `apps/backend/src/features/agent/agent-config.test.ts` (or agent-identity.test.ts — wherever yaml round-trip lives)

- [ ] **Step 1: Schema + serialize**

In `agent-config.ts`:

1. Schema (after `knowledge_packs`):
```typescript
    /** Attached projects (ADR 0023): each materializes a worktree. */
    projects: z.array(z.string().min(1)).default([]),
```
2. `buildAgentConfig` input type gains `projects?: string[];` and the merge:
```typescript
      projects: input.projects ?? prev?.runtime_config.projects ?? [],
```
3. Serializer (after the knowledge_packs lines, ~line 117):
```typescript
    "  projects:",
    ...rc.projects.map((p) => `    - ${q(p)}`),
```

- [ ] **Step 2: Service input**

`service.ts` `buildAgentConfig({...})` call site(s): add `projects: input.projects,` next to `knowledgePacks: input.knowledgePacks,`. Add `projects?: string[]` to `UpdateAgentInput` (domain.ts) and the create input.

- [ ] **Step 3: HTTP**

`http.ts`: PATCH body gains (next to knowledgePacks, line ~195):
```typescript
          projects: t.Optional(t.Array(t.String({ minLength: 1 }))),
```
`toAgentResponse` gains (next to knowledgePacks, line ~35):
```typescript
    projects: rc.projects,
```
Validation in the PATCH handler (before `svc.update`): every id must exist —
```typescript
          if (body.projects) {
            for (const pid of body.projects) {
              if (!projectSvc.exists(pid)) {
                return Response.json(
                  { error: `unknown project ${pid}` },
                  { status: 400 },
                );
              }
            }
          }
```
`projectSvc` must be threaded into the agent routes factory (check its current factory signature in `http.ts` and the wiring in `bootstrap/features.ts`; add a `projectExists: (id: string) => boolean` dep if threading the whole service is awkward).

- [ ] **Step 4: Round-trip test**

```typescript
test("projects field round-trips through agent.yml", () => {
  const cfg = buildAgentConfig({
    id: "a1",
    name: "A",
    prev: undefined,
    projects: ["p1", "p2"],
  });
  const yaml = serializeAgentYaml(cfg);
  expect(yaml).toContain("  projects:");
  expect(yaml).toContain("- p1");
  const parsed = agentConfigSchema.parse(parseYamlLike(yaml)); // use the existing parse helper in the test file
  expect(parsed.runtime_config.projects).toEqual(["p1", "p2"]);
});
```
Adapt `parseYamlLike` to the file's existing parse helper name — the round-trip pattern already exists for knowledge_packs; mirror it.

- [ ] **Step 5: Verify + commit**

Run: `cd apps/backend && bun test src/features/agent/ && bunx tsc --noEmit -p tsconfig.test.json`
Expected: pass, clean.

```bash
git add apps/backend/src/features/agent/
git commit -m "feat(agent): agent.yml declares attached projects (many-to-many)"
```

---

## Task 3: Reconcile materializes worktrees

**Files:**
- Modify: `apps/backend/src/features/agent/workspace-bridge.ts` (reconcileAgentResources gains a hook)
- Modify: `apps/backend/src/bootstrap/features.ts` (reconcileAgent.fn body)
- Test: extend `apps/backend/src/features/agent/workspace-bridge.test.ts`

- [ ] **Step 1: Bridge hook**

`reconcileAgentResources` gains an optional async callback the composition root provides (keeps the bridge sync and testable):

```typescript
export function reconcileAgentResources(input: {
  workspacePath: string;
  kind: string;
  skillPacks: readonly SkillLink[];
  mcpServers: readonly McpServerEntry[];
  productTools: readonly unknown[];
  knowledgePacks: ReadonlyArray<{ id: string; source: string; name: string; description: string }>;
  /** Extra workspace roots (project worktrees) receiving the same mcp +
   *  product-tools bridge (ADR 0023). The caller materializes them. */
  extraRoots?: readonly string[];
}): void {
  const roots = [input.workspacePath, ...(input.extraRoots ?? [])];
  for (const root of roots) {
    writeMcpConfig(root, input.mcpServers);
    writeProductToolsManifest(root, input.productTools);
  }
  reconcileSkillLinks(input.workspacePath, input.kind, input.skillPacks);
  reconcileKnowledgeResources(input.workspacePath, input.knowledgePacks);
  writeClaudeSettings(input.workspacePath);
}
```

- [ ] **Step 2: Composition root**

In `features.ts` `reconcileAgent.fn` (after the existing resource gathering, before `reconcileAgentResources`):

```typescript
          // ADR 0023: materialize a worktree per attached project and
          // bridge the same config into it. Failures warn, never throw.
          const extraRoots: string[] = [];
          for (const pid of agent.config.runtime_config.projects) {
            const project = projectSvc.getById(pid) as
              | { projectId: string; repoUrl: string | null; defaultBranch: string | null }
              | null;
            if (!project?.repoUrl) {
              console.warn(`[reconcile] agent ${agentId}: project ${pid} missing or no repoUrl, skipped`);
              continue;
            }
            try {
              const mirror = await ensureMirror(config.dataDir, {
                projectId: project.projectId,
                repoUrl: project.repoUrl,
                defaultBranch: project.defaultBranch,
              });
              const wt = await ensureWorktree(mirror, agent.workspacePath, {
                projectId: project.projectId,
                repoUrl: project.repoUrl,
                defaultBranch: project.defaultBranch,
              }, agentId);
              if (wt) extraRoots.push(wt);
              else console.warn(`[reconcile] agent ${agentId}: worktree slot for ${pid} occupied, skipped`);
            } catch (err) {
              console.warn(`[reconcile] agent ${agentId}: worktree for ${pid} failed:`, err);
            }
          }
```

Pass `extraRoots` into `reconcileAgentResources`. Import `ensureMirror`/`ensureWorktree` from `../features/project/worktree.js` (follow the file's existing relative-import style). Verify `config.dataDir` is the right config field name by reading `apps/backend/src/config.ts`.

Detach cleanup (same fn, before materialize): diff the previous config's projects (fetch via `agentSvc`'s pre-update state — simplest: compare against the DB row before this PATCH wrote it; if not accessible here, do the diff inside the agent service update path and call a `detachWorktrees(projectIds)` callback). Prefer the simpler option that compiles; note the choice in the commit body.

- [ ] **Step 3: Bridge test**

```typescript
test("reconcileAgentResources bridges mcp + product tools into extra roots", () => {
  const ws = tmpWorkspace();
  const wt = tmpWorkspace();
  reconcileAgentResources({
    workspacePath: ws,
    kind: "oma",
    skillPacks: [],
    mcpServers: [{ name: "product-tools", transport: "sse", url: "http://127.0.0.1:3005/sse", bearerTokenEnv: "PRODUCT_TOOLS_RUN_TOKEN" }],
    productTools: [{ name: "history_recent" }],
    knowledgePacks: [],
    extraRoots: [wt],
  });
  expect(existsSync(join(wt, ".mcp.json"))).toBe(true);
  expect(existsSync(join(wt, ".oma", "product-tools.json"))).toBe(true);
});
```

- [ ] **Step 4: Verify + commit**

Run: `cd apps/backend && bun test src/features/agent/ src/features/project/`
Expected: pass.

```bash
git add apps/backend/src/features/agent/workspace-bridge.ts apps/backend/src/bootstrap/features.ts apps/backend/src/features/agent/workspace-bridge.test.ts
git commit -m "feat(backend): reconcile materializes project worktrees + bridges config"
```

---

## Task 4: Migration 0032 + conversation.projectId

**Files:**
- Create: `apps/backend/drizzle/backend/0032_project_worktree.sql`
- Modify: `apps/backend/drizzle/backend/meta/_journal.json`
- Modify: `apps/backend/src/infra/db/schema.ts` (conversation column + drop auto_orchestrate + select transform)
- Modify: `apps/backend/src/features/conversation/ports.ts`, `adapter-sqlite.ts`, `http.ts`
- Modify: `apps/backend/src/features/project/domain.ts`, `service.ts`, `http.ts`, `adapter-sqlite.ts` (autoOrchestrate removal)

- [ ] **Step 1: Migration file**

```sql
ALTER TABLE conversation ADD COLUMN project_id text REFERENCES project(project_id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE project DROP COLUMN auto_orchestrate;
```

Journal entry (append, `when` > 1786606000000 — e.g. 1786700000000):
```json
 {
  "idx": 32,
  "version": "6",
  "when": 1786700000000,
  "tag": "0032_project_worktree",
  "breakpoints": true
 }
```

- [ ] **Step 2: Schema + types**

`schema.ts`: conversation table gains
```typescript
    /** Project binding (ADR 0023): runs in this conversation use the
     *  project worktree as cwd. Null = agent workspace (default). */
    projectId: text("project_id").references(() => project.projectId, { onDelete: "restrict" }),
```
Delete the `autoOrchestrate` column + its select transform. Follow the existing select-schema block to add `projectId` passthrough.

`ports.ts` `CreateConversationInput` gains `projectId?: string | null;`; `ConversationRow` gains `projectId: string | null;`. Adapter `createConversation` inserts it; `getConversation` returns it (drizzle select covers new columns automatically). HTTP: create body gains `projectId: t.Optional(t.String())` (validate exists → 400), GET /:id response gains `projectId: conv.projectId`.

- [ ] **Step 3: autoOrchestrate removal (project feature)**

Delete from `domain.ts` (ProjectRow/Create/Update inputs), `service.ts` (create/update signatures + port calls), `http.ts` (body fields), `adapter-sqlite.ts` (insert/update mappings). Run `grep -rn autoOrchestrate apps/backend/src` → expect zero hits.

- [ ] **Step 4: Migration + typecheck verify**

Run: `cd apps/backend && bunx tsc --noEmit -p tsconfig.test.json && bun test src/infra/`
Expected: clean; db tests green (fresh-boot applies 0032).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/drizzle apps/backend/src/infra/db/schema.ts apps/backend/src/features/conversation apps/backend/src/features/project
git commit -m "feat(backend): conversation project binding + drop dead auto_orchestrate"
```

---

## Task 5: resolveWorkspace → worktree

**Files:**
- Modify: `apps/backend/src/bootstrap/features.ts` (resolveWorkspace)
- Test: extend `apps/backend/src/features/agent-run/execution.test.ts`

- [ ] **Step 1: resolveWorkspace logic**

```typescript
    resolveWorkspace: async ({ conversationId, agentMemberId }) => {
      const members = conv.convPort.getMembers(conversationId);
      const member = members.find((m) => m.memberId === agentMemberId);
      const agent = member?.agentId ? await agentSvc.getById(member.agentId) : null;
      const access = agent?.config.runtime_config.permission_mode === "ask"
        ? "read_only"
        : "read_write";
      const convRow = conv.convPort.getConversation(conversationId);
      if (convRow?.projectId) {
        const attached = agent?.config.runtime_config.projects.includes(convRow.projectId);
        if (!attached) {
          throw new Error(
            `agent ${member?.agentId ?? "?"} has not attached project ${convRow.projectId}; ` +
              `attach it on the agent page (agent.yml runtime_config.projects)`,
          );
        }
        const wt = join(agent!.workspacePath, "projects", convRow.projectId);
        return { root: existsSync(wt) ? wt : agent!.workspacePath, access };
      }
      return { root: agent?.workspacePath ?? config.workspaceRoot, access };
    },
```
Notes: read the current body first (field names may differ slightly — `config.workspaceRoot` vs `workspaceRoot`); preserve existing fallbacks. The not-attached case throws → dispatch's failure path (run failed + status event) — verify by reading dispatchInner; if `resolveWorkspace` is called outside a try, move the throw so it lands inside one.

- [ ] **Step 2: execution test**

Add to execution.test.ts:

```typescript
  test("conversation project binding: run cwd is the agent's worktree", async () => {
    const fake = createFakeDaemon();
    const execution = makeExecution(fake);
    // attach project p1 to the agent under test + create conversation with projectId
    // (use the same helpers the file already uses to set up agent+conversation;
    //  set agent config projects: ["p1"] and conversation projectId: "p1",
    //  materialize the worktree dir by hand: mkdir <agentWs>/projects/p1)
    const acquired = await enqueue("normal", "wt-1", "hello");
    await execution.dispatch(acquired.run!.runId);
    await waitForTerminal(acquired.run!.runId);
    expect(fake.executeCalls[0]?.workspaceRoot).toBe(join(agentWs, "projects", "p1"));
  });
```
Materialize the setup with the file's existing fixtures; the fake daemon already records `workspaceRoot` per execute. Also assert the not-attached case: conversation projectId "p9" (never attached) → run status failed, error contains "has not attached project".

- [ ] **Step 3: Verify + commit**

Run: `cd apps/backend && bun test src/features/agent-run/`
Expected: pass.

```bash
git add apps/backend/src/bootstrap/features.ts apps/backend/src/features/agent-run/execution.test.ts
git commit -m "feat(backend): runs in project-bound conversations use the worktree as cwd"
```

---

## Task 6: project delete guard + web touches

**Files:**
- Modify: `apps/backend/src/features/project/service.ts` (delete guard)
- Modify: `apps/web/src/app/(main)/team/[agentId]/page.tsx` + `_components/` (projects picker)
- Modify: `apps/web/src/app/(main)/chat/page.tsx` (conversation project select)
- Modify: `apps/web/src/lib/api.ts` (types if hand-written)

- [ ] **Step 1: delete guard**

`service.ts` `remove`: before deleting, scan agents (inject `listAgentsWithConfig: () => Array<{ id: string; workspacePath: string; config: { runtime_config: { projects: string[] } } }>` dep from the composition root) —

```typescript
    remove(id: string): void {
      const attached = listAgentsWithConfig().filter((a) =>
        a.config.runtime_config.projects.includes(id),
      );
      if (attached.length > 0) {
        throw new ConflictError(
          `project ${id} still attached to: ${attached.map((a) => a.id).join(", ")}`,
        );
      }
      if (!port.deleteProject(id)) throw new ProjectNotFoundError(id);
    },
```
Wire the dep in `bootstrap/features.ts`. HTTP: ConflictError already maps to 409 (verify in the error handler; if not, add).

- [ ] **Step 2: web — agent detail projects picker**

In the agent detail `_components/`, add a Projects section modeled on the existing MCP/knowledge toggles: list all projects (`api.listProjects()`), checkbox per row, mutation `api.updateAgent(id, { projects: checkedIds })`. Reuse the existing toggle-list component pattern from the agent detail page (read it first; do not invent a new pattern).

- [ ] **Step 3: web — chat new-conversation project select**

`chat/page.tsx` handleCreate body gains `projectId` when selected (a small `<select>` fed by `api.listProjects()` next to the agent select; empty option = none). `api.ts` createConversation body type gains `projectId?: string`.

- [ ] **Step 4: Verify + commit**

Run: `cd apps/web && bunx tsc --noEmit -p tsconfig.json && bun test`
Expected: clean, pass. Manual smoke: build not required at this step if audit untouched; final gate runs in Task 7.

```bash
git add apps/backend/src/features/project apps/backend/src/bootstrap/features.ts apps/web/src
git commit -m "feat(web): project picker on agent detail + conversation project binding"
```

---

## Task 7: Full gates + E2E smoke + close

**Files:**
- Modify: `docs/superpowers/specs/2026-08-14-project-worktree-p1-design.md` (check the §6 boxes)

- [ ] **Step 1: Full gates**

Run: `cd /root/my-agent-team && bun run typecheck && bun run lint && bun run test`
Expected: all green.

- [ ] **Step 2: E2E smoke (live)**

1. Restart backend (`hub restart backend`).
2. Create a local source repo; create project via `POST /api/projects` with its `file://` (or absolute) path.
3. `PATCH /api/agents/default {projects:["<id>"]}` → verify `<defaultWs>/projects/<id>/.mcp.json` exists.
4. Create conversation with `projectId`, send a message → run's workspace root is the worktree (fake the model the same way existing E2E smoke does, or verify via the run's dispatch when no model: check reconcile + files only and record the model-catalog limitation as before).

- [ ] **Step 3: Acceptance sweep (spec §6)**

- `grep -rn autoOrchestrate apps/backend/src` → zero.
- Worktree idempotency: re-run PATCH → no errors, files stable.
- Not-attached conversation → failed run with actionable error.

- [ ] **Step 4: Commit + push**

```bash
git add docs/superpowers/specs/2026-08-14-project-worktree-p1-design.md
git commit -m "docs(docs): project worktree P1 acceptance verified"
git push
```
