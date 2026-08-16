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
 *  it). Base moves are branch -f only; two-sided merges are refused (the
 *  spec's honest boundary: single-branch-ahead only). */
export function createWorktreeOps(deps: {
  dataDir: string;
  projectPort: ProjectPort;
  listAgentConfigs: () => Promise<Array<{ id: string; workspacePath: string; projects: string[] }>>;
}): WorktreeOps {
  const projectOf = (projectId: string) => {
    const project = deps.projectPort.getProject(projectId);
    if (!project?.repoUrl) throw new Error(`project ${projectId} has no repoUrl`);
    return project;
  };

  const mirrorOf = async (projectId: string): Promise<string> => {
    const project = projectOf(projectId);
    return ensureMirror(deps.dataDir, {
      projectId: project.projectId,
      repoUrl: project.repoUrl as string,
      defaultBranch: project.defaultBranch,
    });
  };

  /** Base branch name; null defaultBranch falls back to the remote HEAD
   *  the mirror recorded at clone time (resolvable as a raw sha). */
  const baseRef = async (projectId: string, mirror: string): Promise<string> => {
    const named = projectOf(projectId).defaultBranch;
    if (named) return named;
    const head = await Bun.$`git -C ${mirror} symbolic-ref --short HEAD`.nothrow().quiet().text();
    return head.trim() || "main";
  };

  /** rev-list counts [behind ahead] between base and the agent branch. */
  const counts = async (mirror: string, base: string, branch: string) => {
    const out = await Bun.$`git -C ${mirror} rev-list --left-right --count ${base}...${branch}`
      .quiet()
      .nothrow()
      .text();
    const [behind, ahead] = out.trim().split(/\s+/).map(Number);
    return { behind: behind ?? 0, ahead: ahead ?? 0 };
  };

  /** Push the base branch. A mirror clone forbids refspec pushes
   *  (remote.origin.mirror=true) — override the config per-invocation. */
  const pushBase = async (mirror: string, base: string): Promise<void> => {
    const res = await Bun.$`git -C ${mirror} -c remote.origin.mirror=false push origin ${base}`
      .quiet()
      .nothrow();
    if (res.exitCode !== 0) {
      throw new Error(`push failed: ${res.stderr.toString().slice(0, 200)}`);
    }
  };

  /** Move base to the branch tip after the divergence preflight. Shared by
   *  fast-forward and merge (they differ only in the preflight). A failed
   * push rolls the base back to its previous tip (the caller never sees a
   * half-moved state). */
  const moveBase = async (
    projectId: string,
    agentId: string,
    opts: { push: boolean },
    preflight: (mirror: string, base: string, branch: string) => Promise<void>,
  ): Promise<void> => {
    const mirror = await mirrorOf(projectId);
    const base = await baseRef(projectId, mirror);
    const branch = `agent/${agentId}/${projectId}`;
    await preflight(mirror, base, branch);
    const prevTip = (await Bun.$`git -C ${mirror} rev-parse ${base}`.quiet().text()).trim();
    await Bun.$`git -C ${mirror} branch -f ${base} ${branch}`.quiet();
    if (opts.push) {
      try {
        await pushBase(mirror, base);
      } catch (err) {
        await Bun.$`git -C ${mirror} branch -f ${base} ${prevTip}`.quiet().nothrow();
        throw err;
      }
    }
  };

  return {
    async status(projectId) {
      const mirror = await mirrorOf(projectId);
      const base = await baseRef(projectId, mirror);
      const agents = (await deps.listAgentConfigs()).filter((a) => a.projects.includes(projectId));
      const out: WorktreeStatus[] = [];
      for (const a of agents) {
        const branch = `agent/${a.id}/${projectId}`;
        const has =
          (await Bun.$`git -C ${mirror} show-ref --verify refs/heads/${branch}`.quiet().nothrow())
            .exitCode === 0;
        if (!has) continue;
        const { behind, ahead } = await counts(mirror, base, branch);
        out.push({
          agentId: a.id,
          branch,
          ahead,
          behind,
          worktreeReady: existsSync(join(a.workspacePath, "projects", projectId)),
        });
      }
      return out;
    },

    async diff(projectId, agentId) {
      const mirror = await mirrorOf(projectId);
      const base = await baseRef(projectId, mirror);
      return Bun.$`git -C ${mirror} diff ${base}...agent/${agentId}/${projectId}`.quiet().text();
    },

    async fastForward(projectId, agentId, opts) {
      await moveBase(projectId, agentId, opts, async (mirror, base, branch) => {
        // Diverged = the branches share no single-base ancestry: the merge
        // base is neither branch tip.
        const mb = await Bun.$`git -C ${mirror} merge-base ${base} ${branch}`
          .quiet()
          .nothrow()
          .text();
        const baseTip = await Bun.$`git -C ${mirror} rev-parse ${base}`.quiet().text();
        if (mb.trim() !== baseTip.trim()) {
          throw new ConflictError(`fast-forward refused: ${base} diverged from ${branch}`);
        }
      });
    },

    async merge(projectId, agentId, opts) {
      await moveBase(projectId, agentId, opts, async (mirror, base, branch) => {
        // merge-tree preflight in the bare mirror (no worktree needed).
        // Conflict markers AND the "CONFLICT (...)" summary lines arrive on
        // stderr; the tree oid lands on stdout.
        const tree = await Bun.$`git -C ${mirror} merge-tree --write-tree ${base} ${branch} 2>&1`
          .quiet()
          .nothrow();
        const text = tree.text();
        if (tree.exitCode !== 0 || text.includes("<<<<<<<")) {
          const files = [...text.matchAll(/CONFLICT \([^)]*\): .* in (.+)/g)]
            .map((m) => m[1])
            .slice(0, 10);
          throw new ConflictError(
            `merge conflicts: ${files.join(", ") || "see merge-tree output"}`,
          );
        }
        const mb = await Bun.$`git -C ${mirror} merge-base ${base} ${branch}`
          .quiet()
          .nothrow()
          .text();
        const baseTip = await Bun.$`git -C ${mirror} rev-parse ${base}`.quiet().text();
        if (mb.trim() !== baseTip.trim()) {
          throw new ConflictError(
            `diverged; merge both branches manually (base has commits not on ${branch})`,
          );
        }
      });
    },
  };
}
