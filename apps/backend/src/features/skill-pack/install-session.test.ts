import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteSkillPackAdapter } from "./adapter-sqlite.js";
import { posixSkillRoot } from "./entities.js";
import { runInstall, runSync } from "./install-session.js";
import type { SkillPackPort } from "./ports.js";

describe("install-session (deterministic)", () => {
  let port: SkillPackPort;
  let tmp: string;

  beforeEach(() => {
    port = sqliteSkillPackAdapter(openDb(":memory:"));
    tmp = `/tmp/ist-${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(join(tmp, "skill-packs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function registerPack(
    id: string,
    sourceKind: "git" | "zip" = "git",
    sourceUrl: string | null = null,
  ) {
    await port.register({
      id,
      name: id,
      description: "d",
      sourceKind,
      sourceUrl,
      versionRef: null,
      now: Date.now(),
    });
  }

  /** Build a minimal valid skill pack dir with a SKILL.md. */
  function makePackDir(dir: string, name = "test-skill") {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(
      join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: test\n---\n# ${name}\n`,
    );
  }

  test("git install: pending → installing → clone → validate → ready with commit ref", async () => {
    const dataDir = tmp;
    // create a source git repo
    const src = join(tmp, "src");
    mkdirSync(src, { recursive: true });
    makePackDir(src);
    await Bun.$`git init`.cwd(src).quiet();
    await Bun.$`git -C ${src} config user.email "t@t"`.quiet();
    await Bun.$`git -C ${src} config user.name "T"`.quiet();
    await Bun.$`git -C ${src} add .`.quiet();
    await Bun.$`git -C ${src} commit -m init`.quiet();
    const commit = (await Bun.$`git -C ${src} rev-parse HEAD`.quiet().text()).trim();

    await registerPack("p-git", "git", src);
    await runInstall(
      { packId: "p-git", sourceKind: "git", sourceUrl: src, versionRef: null },
      { dataDir, port },
    );

    const row = await port.get("p-git");
    expect(row?.status).toBe("ready");
    expect(row?.installedRef).toBe(commit);
    // the pack landed under the skill-packs root
    expect(existsSync(join(posixSkillRoot(dataDir), "p-git", "test-skill", "SKILL.md"))).toBe(true);
  });

  test("git install failure → status failed with persisted error", async () => {
    await registerPack("p-bad", "git", "https://example.invalid/repo.git");
    await runInstall(
      {
        packId: "p-bad",
        sourceKind: "git",
        sourceUrl: "https://example.invalid/repo.git",
        versionRef: null,
      },
      { dataDir: tmp, port },
    );
    const row = await port.get("p-bad");
    expect(row?.status).toBe("failed");
    expect(row?.error).toBeTruthy();
  });

  test("zip install: stage → unzip safely → validate → ready; temp cleaned up", async () => {
    const dataDir = tmp;
    // build a zip with the `zip` CLI (git is guaranteed; zip may not be -
    // fall back to a python-built zip)
    const packSrc = join(tmp, "pack-src");
    makePackDir(packSrc, "zip-skill");
    const zipPath = join(tmp, "pack.zip");
    const zipped = await Bun.$`zip -r ${zipPath} .`.cwd(packSrc).quiet().nothrow();
    if (zipped.exitCode !== 0) {
      // fallback: python zipfile
      const { exitCode } =
        await Bun.$`python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1],'w').write('zip-skill/SKILL.md')" ${zipPath}`
          .cwd(packSrc)
          .quiet()
          .nothrow();
      expect(exitCode).toBe(0);
    }
    const buffer = await Bun.file(zipPath).arrayBuffer();

    await registerPack("p-zip", "zip", null);
    await runInstall(
      { packId: "p-zip", sourceKind: "zip", sourceUrl: null, versionRef: null },
      { dataDir, port, zipBuffer: Buffer.from(buffer) },
    );

    const row = await port.get("p-zip");
    expect(row?.status).toBe("ready");
    expect(row?.installedRef).toBeTruthy();
    expect(existsSync(join(posixSkillRoot(dataDir), "p-zip", "zip-skill", "SKILL.md"))).toBe(true);
    // no leftover temp zip file
    const leftovers = readdirSync(tmpdir()).filter((f) => f.startsWith(`pack-p-zip`));
    expect(leftovers).toHaveLength(0);
  });

  test("zip with path traversal entries → failed, no install", async () => {
    const dataDir = tmp;
    const packSrc = join(tmp, "evil-src");
    mkdirSync(join(packSrc, "evil"), { recursive: true });
    writeFileSync(join(packSrc, "evil", "SKILL.md"), "---\nname: evil\n---\n");
    // zip entry with ../ escape: python builds it explicitly
    const zipPath = join(tmp, "evil.zip");
    const { exitCode } = await Bun.$`python3 -c "
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('../escape/SKILL.md', '---\nname: x\n---\n')
z.close()
" ${zipPath}`
      .quiet()
      .nothrow();
    expect(exitCode).toBe(0);
    const buffer = await Bun.file(zipPath).arrayBuffer();

    await registerPack("p-evil", "zip", null);
    await runInstall(
      { packId: "p-evil", sourceKind: "zip", sourceUrl: null, versionRef: null },
      { dataDir, port, zipBuffer: Buffer.from(buffer) },
    );

    const row = await port.get("p-evil");
    expect(row?.status).toBe("failed");
    expect(existsSync(join(posixSkillRoot(dataDir), "p-evil"))).toBe(false);
    // no escape happened
    expect(existsSync(join(dataDir, "escape"))).toBe(false);
  });

  test("sync: ready → syncing → ready with new commit; failure → failed", async () => {
    const dataDir = tmp;
    const src = join(tmp, "sync-src");
    mkdirSync(src, { recursive: true });
    makePackDir(src);
    await Bun.$`git init`.cwd(src).quiet();
    await Bun.$`git -C ${src} config user.email "t@t"`.quiet();
    await Bun.$`git -C ${src} config user.name "T"`.quiet();
    await Bun.$`git -C ${src} add .`.quiet();
    await Bun.$`git -C ${src} commit -m init`.quiet();

    await registerPack("p-sync", "git", src);
    await runInstall(
      { packId: "p-sync", sourceKind: "git", sourceUrl: src, versionRef: null },
      { dataDir, port },
    );
    const first = await port.get("p-sync");
    expect(first?.status).toBe("ready");

    // add a commit upstream
    writeFileSync(join(src, "extra.txt"), "x");
    await Bun.$`git -C ${src} add .`.quiet();
    await Bun.$`git -C ${src} commit -m more`.quiet();

    await runSync(
      { packId: "p-sync", sourceKind: "git", sourceUrl: src, versionRef: null },
      { dataDir, port },
    );
    const synced = await port.get("p-sync");
    expect(synced?.status).toBe("ready");
    expect(synced?.installedRef).not.toBe(first?.installedRef);

    // failed sync keeps the pack failed, never ready
    await Bun.$`git -C ${join(posixSkillRoot(dataDir), "p-sync")} remote set-url origin https://example.invalid/x.git`.quiet();
    await runSync(
      {
        packId: "p-sync",
        sourceKind: "git",
        sourceUrl: "https://example.invalid/x.git",
        versionRef: null,
      },
      { dataDir, port },
    );
    const failed = await port.get("p-sync");
    expect(failed?.status).toBe("failed");
  });
  test("sync: already-syncing state does not double-transition (production path)", async () => {
    const dataDir = tmp;
    const src = join(tmp, "sync2-src");
    mkdirSync(src, { recursive: true });
    makePackDir(src);
    await Bun.$`git init`.cwd(src).quiet();
    await Bun.$`git -C ${src} config user.email "t@t"`.quiet();
    await Bun.$`git -C ${src} config user.name "T"`.quiet();
    await Bun.$`git -C ${src} add .`.quiet();
    await Bun.$`git -C ${src} commit -m init`.quiet();

    await registerPack("p-sync2", "git", src);
    await runInstall(
      { packId: "p-sync2", sourceKind: "git", sourceUrl: src, versionRef: null },
      { dataDir, port },
    );

    writeFileSync(join(src, "extra2.txt"), "x");
    await Bun.$`git -C ${src} add .`.quiet();
    await Bun.$`git -C ${src} commit -m more`.quiet();

    // Service already transitioned ready → syncing before triggering the session.
    await port.applyInstallTransition("p-sync2", "syncing", { now: Date.now() });
    await runSync(
      { packId: "p-sync2", sourceKind: "git", sourceUrl: src, versionRef: null },
      { dataDir, port },
    );
    const synced = await port.get("p-sync2");
    expect(synced?.status).toBe("ready");
    expect(synced?.installedRef).toBeTruthy();
  });
});
