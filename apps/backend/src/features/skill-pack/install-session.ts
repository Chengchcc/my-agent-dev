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
  /** Rev the user confirmed for sync. When set, runSync resets only if the
   *  fetched FETCH_HEAD still matches — closing the confirm TOCTOU. */
  expectedRev?: string | null;
}
/** Sync was blocked because the upstream ref moved past the recorded HEAD. */
export class UpstreamChangedError extends Error {
  constructor(
    public readonly from: string | null,
    public readonly to: string,
  ) {
    super(`upstream changed from ${from ?? "unknown"} to ${to}`);
    this.name = "UpstreamChangedError";
  }
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

/** A git ref that may safely appear in `git fetch ... <ref>` argv: parse-options
 *  accepts options after positionals, so a "-..." value would inject fetch
 *  options (e.g. --upload-pack). Bare refspec characters only. */
function assertSafeRef(ref: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new Error(`unsafe git ref: ${ref}`);
  }
  return ref;
}

/** Fetch the DB-stored source URL (optionally ref) and return the remote
 *  FETCH_HEAD rev. Read-only: does NOT reset the working tree. The stored URL
 *  is used directly — fetching the "origin" alias would trust .git/config,
 *  which lives inside the pack dir and can be rewritten by any process (or
 *  pack content) to an attacker transport. */
async function fetchRemoteRev(source: InstallSource, packDir: string): Promise<string> {
  if (!source.sourceUrl) throw new Error("git sync requires a stored sourceUrl");
  const fetchArgs = ["fetch", source.sourceUrl];
  if (source.versionRef) fetchArgs.push(assertSafeRef(source.versionRef));
  const fetchResult = await git(fetchArgs, packDir);
  if (fetchResult.exitCode !== 0) throw new Error(`git fetch failed: ${fetchResult.stderr}`);
  const revResult = await git(["rev-parse", "FETCH_HEAD"], packDir);
  if (revResult.exitCode !== 0)
    throw new Error(`git rev-parse FETCH_HEAD failed: ${revResult.stderr}`);
  return revResult.stdout;
}

/** Compare the recorded HEAD to the remote FETCH_HEAD. Returns null when
 *  there is no prior record or the ref has not moved; otherwise the change. */
export async function checkUpstream(
  source: InstallSource,
  deps: InstallSessionDeps,
): Promise<{ from: string | null; to: string } | null> {
  const cwd = posixSkillRoot(deps.dataDir);
  const packDir = resolve(cwd, source.packId);
  assertSafeEntry(source.packId);
  if (source.sourceKind !== "git")
    throw new Error(`cannot check upstream for non-git pack: ${source.packId}`);
  const to = await fetchRemoteRev(source, packDir);
  const row = await deps.port.get(source.packId);
  const from = row?.installedRef ?? null;
  if (!from || from === to) return null;
  return { from, to };
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
    // The service already transitions ready→syncing before triggering the
    // session. Direct test callers may still be ready, so only transition
    // when not already syncing (syncing→syncing is an illegal transition).
    const current = await deps.port.get(source.packId);
    if (current?.status !== "syncing") {
      await deps.port.applyInstallTransition(source.packId, "syncing", { now: Date.now() });
    }
    const installedRef = await fetchRemoteRev(source, packDir);
    if (source.expectedRev && installedRef !== source.expectedRev) {
      throw new Error(
        `upstream moved during confirm: expected ${source.expectedRev}, got ${installedRef}`,
      );
    }
    const resetResult = await git(["reset", "--hard", "FETCH_HEAD"], packDir);
    if (resetResult.exitCode !== 0) throw new Error(`git reset failed: ${resetResult.stderr}`);
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
