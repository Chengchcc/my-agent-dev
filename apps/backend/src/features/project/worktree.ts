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

/** Ensure the shared bare mirror exists and is fresh (clone --mirror on
 *  first attach, fetch --prune afterwards). Concurrent-safe: the clone
 *  writes to `<id>.git.tmp` then renames; a stale tmp is removed first.
 *  Returns the mirror path. */
export async function ensureMirror(dataDir: string, project: WorktreeProject): Promise<string> {
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

/** Ensure the agent's worktree exists on its own branch
 *  (`agent/<agentId>/<projectId>`). Returns the worktree path, or null
 *  when the slot is occupied by a plain directory (user's own files are
 *  never clobbered). */
export async function ensureWorktree(
  mirrorPath: string,
  agentWorkspace: string,
  project: WorktreeProject,
  agentId: string,
): Promise<string | null> {
  const wt = worktreePath(agentWorkspace, project.projectId);
  const listed = await Bun.$`git -C ${mirrorPath} worktree list --porcelain`.text();
  if (listed.includes(wt)) return wt;
  if (existsSync(wt)) return null;
  const branch = branchName(agentId, project.projectId);
  const hasBranch =
    (await Bun.$`git -C ${mirrorPath} show-ref --verify refs/heads/${branch}`.quiet().nothrow())
      .exitCode === 0;
  const target = project.defaultBranch ?? "HEAD";
  mkdirSync(join(agentWorkspace, "projects"), { recursive: true });
  if (hasBranch) {
    // Branch survived (e.g. worktree dir removed out-of-band): check it out.
    await Bun.$`git -C ${mirrorPath} worktree add ${wt} ${branch}`.quiet();
  } else {
    await Bun.$`git -C ${mirrorPath} worktree add -b ${branch} ${wt} ${target}`.quiet();
  }
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
