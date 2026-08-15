import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteProjectAdapter } from "./adapter-sqlite.js";
import { projectRoutes } from "./http.js";
import { createProjectService } from "./service.js";
import { createWorktreeOps } from "./worktree-ops.js";

const db = openDb(":memory:");
const svc = createProjectService({
  port: sqliteProjectAdapter(db),
  idGen: () => `p-${Math.random().toString(36).slice(2, 10)}`,
});

describe("project worktree endpoints", () => {
  test("501 without ops; status/diff/fast-forward with ops over a real repo", async () => {
    const app501 = new Elysia().use(projectRoutes(svc));
    const r501 = await app501.handle(new Request("http://localhost/api/projects/p1/worktrees"));
    expect(r501.status).toBe(501);

    // Real repo through the P1 plumbing.
    const dir = mkdtempSync(join(tmpdir(), "wops-http-"));
    try {
      const src = join(dir, "src");
      mkdirSync(src, { recursive: true });
      await Bun.$`git init -b main ${src}`.quiet();
      await Bun.$`git -C ${src} config user.email t@t`.quiet();
      await Bun.$`git -C ${src} config user.name t`.quiet();
      await Bun.$`echo base > ${join(src, "F.txt")}`.quiet();
      await Bun.$`git -C ${src} add -A`.quiet();
      await Bun.$`git -C ${src} commit -m base`.quiet();
      const row = svc.createProject({
        name: `wt-http-${Date.now()}`,
        repoUrl: src,
        defaultBranch: "main",
      });
      const ops = createWorktreeOps({
        dataDir: dir,
        projectPort: svc.port,
        listAgentConfigs: async () => [],
      });
      const app = new Elysia().use(projectRoutes(svc, ops));
      const st = await app.handle(
        new Request(`http://localhost/api/projects/${row.projectId}/worktrees`),
      );
      expect(st.status).toBe(200);
      const body = (await st.json()) as { worktrees: unknown[] };
      expect(body.worktrees).toEqual([]);
      // No agents attached -> empty is the happy path; divergence/FF flows
      // are covered by worktree-ops.test.ts.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
