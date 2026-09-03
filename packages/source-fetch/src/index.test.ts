import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  directoryFingerprint,
  fetchGitSource,
  fetchGitSourceSync,
  materializeZipSource,
} from "./index.js";

function makeGitRepo(tmp: string): string {
  const repo = mkdtempSync(join(tmp, "sf-repo-"));
  writeFileSync(join(repo, "README.md"), "hello");
  spawnSync("git", ["init", "-b", "main"], { cwd: repo });
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "c1"], {
    cwd: repo,
  });
  return repo;
}

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
    const repo = makeGitRepo(tmpdir());
    try {
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

  test("fetchGitSourceSync clones and returns same root/rev", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sf-gitsync-"));
    const repo = makeGitRepo(tmpdir());
    try {
      const fetched = fetchGitSourceSync({ url: repo, dataDir, slug: "sync-demo" });
      expect(fetched.root).toBe(join(dataDir, "sync-demo"));
      expect(fetched.rev).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(join(fetched.root, "README.md"))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("materializeZipSource rejects path-escape entries", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sf-zip-"));
    const zipPath = join(tmpdir(), `sf-evil-${Date.now()}.zip`);
    const script = `import zipfile; z=zipfile.ZipFile(${JSON.stringify(zipPath)},'w'); z.writestr('../evil.txt','pwn'); z.close()`;
    const py = spawnSync("python3", ["-c", script], { encoding: "utf-8" });
    expect(py.status).toBe(0);
    try {
      const buffer = readFileSync(zipPath);
      await expect(materializeZipSource({ buffer, dataDir, slug: "evil" })).rejects.toThrow(
        /unsafe zip entry/,
      );
      expect(existsSync(join(dataDir, "evil"))).toBe(false);
      expect(existsSync(join(tmpdir(), "evil.txt"))).toBe(false);
    } finally {
      rmSync(zipPath, { force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
