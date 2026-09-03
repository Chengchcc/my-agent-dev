import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgePackRow } from "./entities.js";
import { installKnowledgePack } from "./install.js";
import type { KnowledgePackPort } from "./ports.js";

function memoryPort(): KnowledgePackPort {
  const rows = new Map<string, KnowledgePackRow>();
  return {
    create(row) {
      rows.set(row.id, { ...row });
      return { ...row };
    },
    list() {
      return [...rows.values()].map((r) => ({ ...r }));
    },
    getById(id) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    update(id, patch) {
      const cur = rows.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      rows.set(id, next);
      return { ...next };
    },
    delete(id) {
      return rows.delete(id);
    },
  };
}

describe("knowledge install (path safety)", () => {
  test("zip install succeeds and lands under knowledge root", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kp-test-"));
    const zipPath = join(dataDir, "pack.zip");
    const { exitCode } = await Bun.$`python3 -c "
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('docs/a.md', '# A')
z.close()
" ${zipPath}`
      .quiet()
      .nothrow();
    expect(exitCode).toBe(0);

    const port = memoryPort();
    const row = await installKnowledgePack(
      { dataDir, port, zipBuffer: Buffer.from(await Bun.file(zipPath).arrayBuffer()) },
      {
        id: "kp-zip",
        name: "Zip",
        description: "d",
        sourceKind: "zip",
        sourceUrl: null,
        versionRef: null,
      },
    );
    expect(row.status).toBe("ready");
    expect(row.installedRef).toBe(join(dataDir, "knowledge", "kp-zip"));
    expect(existsSync(join(dataDir, "knowledge", "kp-zip", "docs", "a.md"))).toBe(true);
    expect(row.sourceRev).toBeTruthy();
    rmSync(dataDir, { recursive: true, force: true });
  });
  test("git install records resolved HEAD as sourceRev", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kp-git-"));
    const repo = join(dataDir, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "a.md"), "# A");
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git -C ${repo} config user.email "t@t"`.quiet();
    await Bun.$`git -C ${repo} config user.name "T"`.quiet();
    await Bun.$`git -C ${repo} add .`.quiet();
    await Bun.$`git -C ${repo} commit -m init`.quiet();
    const head = (await Bun.$`git -C ${repo} rev-parse HEAD`.quiet().text()).trim();

    const port = memoryPort();
    const row = await installKnowledgePack(
      { dataDir, port },
      {
        id: "kp-git",
        name: "Git",
        description: "d",
        sourceKind: "git",
        sourceUrl: repo,
        versionRef: null,
      },
    );
    expect(row.status).toBe("ready");
    expect(row.sourceRev).toBe(head);
    expect(row.installedRef).toBe(join(dataDir, "knowledge", "kp-git"));
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("zip with path-traversal entries fails; no file escapes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kp-evil-"));
    const zipPath = join(dataDir, "evil.zip");
    const { exitCode } = await Bun.$`python3 -c "
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('../escape/a.md', '# A')
z.close()
" ${zipPath}`
      .quiet()
      .nothrow();
    expect(exitCode).toBe(0);

    const port = memoryPort();
    const row = await installKnowledgePack(
      { dataDir, port, zipBuffer: Buffer.from(await Bun.file(zipPath).arrayBuffer()) },
      {
        id: "kp-evil",
        name: "Evil",
        description: "d",
        sourceKind: "zip",
        sourceUrl: null,
        versionRef: null,
      },
    );
    expect(row.status).toBe("failed");
    expect(existsSync(join(dataDir, "escape"))).toBe(false);
    rmSync(dataDir, { recursive: true, force: true });
  });
});
