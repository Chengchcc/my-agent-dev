import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

/** Fetched source materialized onto disk, with a version fingerprint for
 *  cache keying. Pure mechanical capability — no business semantics. */
export interface FetchedSource {
  /** Absolute path to the materialized directory. */
  readonly root: string;
  /** Version fingerprint (git HEAD, zip hash, directory checksum). */
  readonly rev: string;
}

/** Thrown when a pinned commit ref does not match the fetched HEAD.
 *  Fail-closed: the materialized target is removed before throwing. */
export class SourceRevMismatchError extends Error {
  constructor(
    readonly expectedRev: string,
    readonly actualRev: string,
  ) {
    super(`source rev mismatch: expected ${expectedRev}, got ${actualRev}`);
    this.name = "SourceRevMismatchError";
  }
}

/** A 40-hex git commit SHA pins the exact upstream object (lockfile form).
 *  Anything else is a movable branch/tag ref and is NOT a trust lock. */
function isCommitRef(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

function assertSafeSegment(name: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === "." || name === "..") {
    throw new Error(`unsafe path segment: ${name}`);
  }
  return name;
}

function slugify(source: string): string {
  return source.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80);
}

/** Options shared by the async and sync git fetch surfaces. */
export interface GitSourceOptions {
  url: string;
  dataDir: string;
  /** Branch/tag ref, or a 40-hex commit SHA used as a trust pin. */
  ref?: string;
  slug?: string;
}

/** Single clone implementation (no async/sync duplication):
 *  depth-1 clone, movable ref via --branch, commit pin via post-clone
 *  HEAD verification. A pin mismatch removes the target and fails closed. */
function cloneGitSource(opts: GitSourceOptions): FetchedSource {
  const slug = assertSafeSegment(opts.slug ?? slugify(opts.url));
  const target = path.resolve(opts.dataDir, slug);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(path.resolve(opts.dataDir), { recursive: true });
  const pinnedRev = opts.ref && isCommitRef(opts.ref) ? opts.ref.toLowerCase() : null;
  const args = ["clone", "--depth", "1"];
  if (opts.ref && !pinnedRev) args.push("--branch", opts.ref);
  args.push(opts.url, target);
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: opts.dataDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git clone failed: ${String(proc.stderr ?? "").trim()}`);
  }
  const revProc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: target,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rev = revProc.exitCode === 0 ? String(revProc.stdout ?? "").trim() : "unknown";
  if (pinnedRev && rev.toLowerCase() !== pinnedRev) {
    rmSync(target, { recursive: true, force: true });
    throw new SourceRevMismatchError(pinnedRev, rev);
  }
  return { root: target, rev };
}

/** Async surface for backend install paths; the clone itself is sync. */
export async function fetchGitSource(opts: GitSourceOptions): Promise<FetchedSource> {
  return cloneGitSource(opts);
}

/** Sync surface for oma marketplace / addMarketplace. */
export function fetchGitSourceSync(opts: GitSourceOptions): FetchedSource {
  return cloneGitSource(opts);
}

function unzip(zipPath: string, extractDir: string): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const proc = Bun.spawn(["unzip", "-q", zipPath, "-d", extractDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.exited
      .then((code) => resolve({ exitCode: code ?? 1, stderr: "" }))
      .catch(() => {
        resolve({ exitCode: 1, stderr: "unzip spawn failed" });
      });
  });
}

/** Reject a zip whose entries escape the extract root — checked BEFORE any
 *  extraction so a crafty unzip cannot smuggle a file out. Fail-closed. */
function assertSafeZipEntries(entries: readonly string[]): void {
  for (const name of entries) {
    const normalized = name.replace(/\\/g, "/");
    if (
      normalized.startsWith("/") ||
      /^[a-zA-Z]:/.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`unsafe zip entry: ${name}`);
    }
  }
}

/** Materialize a zip buffer into dataDir/<slug>. Safety: no path escape. */
export async function materializeZipSource(opts: {
  buffer: Uint8Array;
  dataDir: string;
  slug: string;
}): Promise<FetchedSource> {
  const slug = assertSafeSegment(opts.slug);
  const target = path.resolve(opts.dataDir, slug);
  mkdirSync(path.resolve(opts.dataDir), { recursive: true });
  const tmpZip = path.join(tmpdir(), `src-${slug}-${Date.now()}.zip`);
  const tmpDir = path.join(tmpdir(), `src-${slug}-unzip-${Date.now()}`);
  writeFileSync(tmpZip, opts.buffer);
  // Pre-extraction safety: list the zip entries and reject escapes before
  // unzip ever touches the filesystem (fail-closed, unzip-version-agnostic).
  const listProc = Bun.spawnSync(["unzip", "-Z1", tmpZip], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (listProc.exitCode === 0) {
    const entries = String(listProc.stdout ?? "")
      .split("\n")
      .filter((line) => line.length > 0);
    try {
      assertSafeZipEntries(entries);
    } catch (err) {
      rmSync(tmpZip, { force: true });
      rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    }
  }
  mkdirSync(tmpDir, { recursive: true });
  try {
    const extractDir = path.join(tmpDir, "extract");
    const result = await unzip(tmpZip, extractDir);
    if (result.exitCode !== 0) throw new Error(`unzip failed: ${result.stderr}`);
    validateExtractedEntries(extractDir, extractDir);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(extractDir, target);
    return { root: target, rev: directoryFingerprint(target) };
  } finally {
    rmSync(tmpZip, { force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Reject symlinks and path escapes inside an extracted tree. */
export function validateExtractedEntries(root: string, dir: string): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.resolve(dir, ent.name);
    if (!full.startsWith(path.resolve(root))) {
      throw new Error(`path escape: ${full}`);
    }
    if (ent.isSymbolicLink()) throw new Error(`symlink not allowed: ${full}`);
    if (ent.isDirectory()) validateExtractedEntries(root, full);
  }
}

/** Directory fingerprint: sorted (relpath, sha256), skip node_modules — the
 *  version key for local/skills sources. */
export function directoryFingerprint(dir: string): string {
  const files: Array<{ rel: string; hash: string }> = [];
  const walk = (d: string, prefix: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      if (ent.name === "node_modules") continue;
      const full = path.join(d, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === ".git") continue;
        walk(full, rel);
      } else if (ent.isFile()) {
        files.push({ rel, hash: createHash("sha256").update(readFileSync(full)).digest("hex") });
      }
    }
  };
  walk(dir, "");
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const aggregate = files.map((f) => `${f.rel}\0${f.hash}`).join("\n");
  return `sha256:${createHash("sha256").update(aggregate).digest("hex")}`;
}
