import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectPort } from "./ports.js";
import type { ProjectRow } from "./domain.js";
import { createWorktreeOps } from "./worktree-ops.js";
import { ensureMirror, ensureWorktree } from "./worktree.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** source repo with one base commit on main. */
async function makeSource(dir: string): Promise<string> {
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  await Bun.$`git init -b main ${src}`.quiet();
  await Bun.$`git -C ${src} config user.email t@t`.quiet();
  await Bun.$`git -C ${src} config user.name t`.quiet();
  await Bun.$`echo base > ${join(src, "F.txt")}`.quiet();
  await Bun.$`git -C ${src} add -A`.quiet();
  await Bun.$`git -C ${src} commit -m base`.quiet();
  return src;
}

const PID = "pp";

function projectRow(repoUrl: string): ProjectRow {
  return {
    projectId: PID,
    name: "p",
    repoUrl,
    defaultBranch: "main",
    createdAt: 0,
    updatedAt: 0,
  };
}

function fakeProjectPort(repoUrl: string): ProjectPort {
  return {
    createProject: () => {
      throw new Error("unused");
    },
    getProject: (id: string) => (id === PID ? projectRow(repoUrl) : null),
    listProjects: () => [],
    updateProject: () => null,
    deleteProject: () => false,
  };
}

/** Materialize mirror + the a1 worktree (P1 plumbing — setup, not under test). */
async function setup(dir: string): Promise<{ mirror: string; wt: string; src: string }> {
  const src = await makeSource(dir);
  const dataDir = join(dir, "data");
  const agentWs = join(dir, "agent");
  mkdirSync(agentWs, { recursive: true });
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
  return { mirror, wt, src };
}

const commit = (wt: string, msg: string) =>
  Bun.$`git -C ${wt} -c user.email=t@t -c user.name=t commit -q -m ${msg}`.quiet();

function opsFor(dir: string, src: string) {
  return createWorktreeOps({
    dataDir: join(dir, "data"),
    projectPort: fakeProjectPort(src),
    listAgentConfigs: async () => [
      { id: "a1", workspacePath: join(dir, "agent"), projects: [PID] },
    ],
  });
}

describe("worktree ops", () => {
  test("status counts ahead/behind; diff shows the branch changes; fast-forward zeroes ahead; divergence refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wops-"));
    dirs.push(dir);
    const { mirror, wt, src } = await setup(dir);
    await Bun.$`echo work > ${join(wt, "W.txt")}`.quiet();
    await Bun.$`git -C ${wt} add -A`.quiet();
    await commit(wt, "w");

    const ops = opsFor(dir, src);
    const st = await ops.status(PID);
    console.log("DEBUG mirror refs:", await Bun.$`git -C  show-ref`.nothrow().quiet().text());
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ agentId: "a1", ahead: 1, behind: 0, worktreeReady: true });

    const diff = await ops.diff(PID, "a1");
    expect(diff).toContain("W.txt");

    await ops.fastForward(PID, "a1", { push: false });
    const st2 = await ops.status(PID);
    expect(st2[0]?.ahead).toBe(0);

    // Divergence: advance the base past the agent branch (simulating
    // another agent's merge landing first) plus a new agent commit —
    // merge-base no longer equals the base tip.
    await Bun.$`git -C ${mirror} branch other main`.quiet();
    const otherWt = join(dir, "other-wt");
    await Bun.$`git -C ${mirror} worktree add -q ${otherWt} other`.quiet();
    await Bun.$`echo other > ${join(otherWt, "O.txt")}`.quiet();
    await Bun.$`git -C ${otherWt} add -A`.quiet();
    await commit(otherWt, "o");
    await Bun.$`git -C ${mirror} branch -f main other`.quiet();
    await Bun.$`echo w2 > ${join(wt, "H.txt")}`.quiet();
    await Bun.$`git -C ${wt} add -A`.quiet();
    await commit(wt, "w2");
    await expect(ops.fastForward(PID, "a1", { push: false })).rejects.toThrow(/diverged/);
    await expect(ops.merge(PID, "a1", { push: false })).rejects.toThrow(/diverged/);
  }, 20_000);

  test("merge with conflicting changes reports the conflict files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wops2-"));
    dirs.push(dir);
    const { mirror, wt, src } = await setup(dir);
    // Agent edits F.txt; main also edits F.txt -> conflict.
    await Bun.$`echo agent > ${join(wt, "F.txt")}`.quiet();
    await Bun.$`git -C ${wt} add -A`.quiet();
    await commit(wt, "a");
    // The base itself (not just the remote) carries the conflicting edit:
    // advance main in the mirror, as another agent's merge would.
    await Bun.$`git -C ${mirror} branch other main`.quiet();
    const otherWt = join(dir, "other-wt");
    await Bun.$`git -C ${mirror} worktree add -q ${otherWt} other`.quiet();
    await Bun.$`echo main > ${join(otherWt, "F.txt")}`.quiet();
    await Bun.$`git -C ${otherWt} add -A`.quiet();
    await commit(otherWt, "m");
    await Bun.$`git -C ${mirror} branch -f main other`.quiet();

    const ops = opsFor(dir, src);
    await expect(ops.merge(PID, "a1", { push: false })).rejects.toThrow(/F\.txt/);
  }, 20_000);
});
