import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SkillPackSource } from "./entities.js";
import { posixSkillRoot } from "./entities.js";
import type { SkillPackPort } from "./ports.js";
import {
  assertSafeEntry,
  computeDirChecksum,
  validateExtractedEntries,
  validatePackDir,
} from "./tools.js";

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

function unzip(zipPath: string, extractDir: string): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("unzip", ["-o", zipPath, "-d", extractDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => resolve({ exitCode: code ?? 1, stderr }));
  });
}

/** Deterministic git install: pending → installing → clone/checkout →
 *  validate → ready; any failure → failed with error persisted. */
export async function runInstall(source: InstallSource, deps: InstallSessionDeps): Promise<void> {
  const cwd = posixSkillRoot(deps.dataDir);
  const targetDir = source.packId;
  const targetFull = resolve(cwd, targetDir);
  let tmpZip: string | null = null;
  try {
    assertSafeEntry(targetDir);
    await deps.port.applyInstallTransition(source.packId, "installing", { now: Date.now() });

    let installedRef = "";
    if (source.sourceKind === "git") {
      if (!source.sourceUrl) throw new Error("git install requires a sourceUrl");
      const args = ["clone", "--depth", "1"];
      if (source.versionRef) args.push("--branch", source.versionRef);
      args.push(source.sourceUrl, targetDir);
      const result = await git(args, cwd);
      if (result.exitCode !== 0) throw new Error(`git clone failed: ${result.stderr}`);
      const rev = await git(["rev-parse", "HEAD"], targetFull);
      installedRef = rev.exitCode === 0 ? rev.stdout : "unknown";
    } else {
      if (!deps.zipBuffer) throw new Error("zip install requires a zipBuffer");
      tmpZip = join(tmpdir(), `pack-${source.packId}.zip`);
      writeFileSync(tmpZip, deps.zipBuffer);
      const tmpDir = mkdtempSync(join(tmpdir(), "pack-unzip-"));
      try {
        const extractDir = join(tmpDir, "extract");
        const result = await unzip(tmpZip, extractDir);
        if (result.exitCode !== 0) throw new Error(`unzip failed: ${result.stderr}`);
        // safety boundary: no symlinks, no path escape
        validateExtractedEntries(extractDir, extractDir);
        if (existsSync(targetFull)) rmSync(targetFull, { recursive: true, force: true });
        renameSync(extractDir, targetFull);
        installedRef = computeDirChecksum(cwd, targetDir);
      } finally {
        try {
          rmSync(tmpDir, { recursive: true });
        } catch {
          /* ignore */
        }
      }
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
    if (tmpZip) {
      try {
        unlinkSync(tmpZip);
      } catch {
        /* ok */
      }
    }
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
