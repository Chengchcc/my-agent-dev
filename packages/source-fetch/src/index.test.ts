import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryFingerprint, fetchGitSource } from "./index.js";

describe("source-fetch", () => {
  test("directoryFingerprint skips node_modules and changes on content edit", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-fp-"));
    try {
      mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(dir, "a.txt"), "a");
      writeFileSync(join(dir, "node_modules", "dep", "x.js"), "x");
      const h1 = directoryFingerprint(dir);
      expect(h1.startsWith("sha256:")).toBe(true);
      // node_modules change must not affect the fingerprint
      writeFileSync(join(dir, "node_modules", "dep", "y.js"), "y");
      expect(directoryFingerprint(dir)).toBe(h1);
      // content change does
      writeFileSync(join(dir, "a.txt"), "b");
      expect(directoryFingerprint(dir)).not.toBe(h1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fetchGitSource clones a repo and returns HEAD rev", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sf-git-"));
    const repo = mkdtempSync(join(tmpdir(), "sf-repo-"));
    try {
      // Build a tiny git repo to clone.
      const { spawnSync } = await import("node:child_process");
      writeFileSync(join(repo, "README.md"), "hello");
      spawnSync("git", ["init", "-b", "main"], { cwd: repo });
      spawnSync("git", ["add", "-A"], { cwd: repo });
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "c1"], {
        cwd: repo,
      });
      const fetched = await fetchGitSource({ url: repo, dataDir, slug: "demo" });
      expect(fetched.root).toBe(join(dataDir, "demo"));
      expect(fetched.rev).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(join(fetched.root, "README.md"))).toBe(true);
      writeFileSync(join(dataDir, "demo", "README.md"), "world");
      // refetch replaces atomically (fresh clone)
      const fetched2 = await fetchGitSource({ url: repo, dataDir, slug: "demo" });
      expect(await Bun.file(join(fetched2.root, "README.md")).text()).toBe("hello");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
