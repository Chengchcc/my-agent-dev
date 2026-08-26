import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fetchGitSource, materializeZipSource } from "@chengchenccc/source-fetch";
import type { SkillPackSource } from "./entities.js";
import { posixSkillRoot } from "./entities.js";
import type { SkillPackPort } from "./ports.js";
import { assertSafeEntry, validatePackDir } from "./tools.js";

export interface InstallSessionDeps {
  dataDir: string;
  port: SkillPackPort;
  /** Buffer for zip uploads — staged to a temp file, cleaned up after. */
  zipBuffer?: Buffer;
}

export interface InstallSource {
  packId: string;
  sourceKind: SkillPackSource;
  sourceUrl: string | null;
  versionRef: string | null;
}

function git(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) =>
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 1 }),
    );
  });
}

/** Deterministic git install: pending → installing → clone/checkout →
 *  validate → ready; any failure → failed with error persisted. */
export async function runInstall(source: InstallSource, deps: InstallSessionDeps): Promise<void> {
  const cwd = posixSkillRoot(deps.dataDir);
  const targetDir = source.packId;
  try {
    assertSafeEntry(targetDir);
    await deps.port.applyInstallTransition(source.packId, "installing", { now: Date.now() });

    let installedRef = "";
    if (source.sourceKind === "git") {
      if (!source.sourceUrl) throw new Error("git install requires a sourceUrl");
      // Shared base (spec: skill-pack git clone reuses source-fetch; same
      // cached git rev as oma marketplace). slug = packId keeps the target
      // directory naming the feature already controls.
      const fetched = await fetchGitSource({
        url: source.sourceUrl,
        dataDir: cwd,
        slug: source.packId,
        ...(source.versionRef ? { ref: source.versionRef } : {}),
      });
      installedRef = fetched.rev;
    } else {
      if (!deps.zipBuffer) throw new Error("zip install requires a zipBuffer");
      // Shared base: zip materialize + fingerprint (+ symlink/path-escape
      // guard) replaces the local unzip/validate/checksum three-step.
      const fetched = await materializeZipSource({
        buffer: deps.zipBuffer,
        dataDir: cwd,
        slug: source.packId,
      });
      installedRef = fetched.rev;
    }

    if (!(await validatePackDir(cwd, targetDir))) {
      throw new Error("installed pack has no valid SKILL.md");
    }
    await deps.port.applyInstallTransition(source.packId, "ready", {
      installedRef,
      now: Date.now(),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[skill-pack] install failed for ${source.packId}:`, error);
    try {
      await deps.port.applyInstallTransition(source.packId, "failed", {
        error,
        now: Date.now(),
      });
    } catch {
      /* status already terminal */
    }
  } finally {
    // no temp files to clean (base materialize handles its own tmpfs)
  }
}

/** Deterministic git sync: ready → syncing → fetch/update → validate →
 *  ready; failure → failed. */
export async function runSync(source: InstallSource, deps: InstallSessionDeps): Promise<void> {
  const cwd = posixSkillRoot(deps.dataDir);
  const packDir = resolve(cwd, source.packId);
  try {
    assertSafeEntry(source.packId);
    await deps.port.applyInstallTransition(source.packId, "syncing", { now: Date.now() });

    const fetchArgs = ["fetch", "origin"];
    if (source.versionRef) fetchArgs.push(source.versionRef);
    const fetchResult = await git(fetchArgs, packDir);
    if (fetchResult.exitCode !== 0) throw new Error(`git fetch failed: ${fetchResult.stderr}`);
    const resetResult = await git(["reset", "--hard", "FETCH_HEAD"], packDir);
    if (resetResult.exitCode !== 0) throw new Error(`git reset failed: ${resetResult.stderr}`);
    const revResult = await git(["rev-parse", "HEAD"], packDir);
    const installedRef = revResult.exitCode === 0 ? revResult.stdout : "unknown";

    if (!(await validatePackDir(cwd, source.packId))) {
      throw new Error("synced pack has no valid SKILL.md");
    }
    await deps.port.applyInstallTransition(source.packId, "ready", {
      installedRef,
      now: Date.now(),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[skill-pack] sync failed for ${source.packId}:`, error);
    try {
      await deps.port.applyInstallTransition(source.packId, "failed", {
        error,
        now: Date.now(),
      });
    } catch {
      /* status already terminal */
    }
  }
}
