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

function assertSafeSegment(name: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === "." || name === "..") {
    throw new Error(`unsafe path segment: ${name}`);
  }
  return name;
}

function slugify(source: string): string {
  return source.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80);
}

/** Clone a git source into dataDir/<slug> (depth 1, optional branch/tag ref).
 *  Replaces an existing directory atomically (rm + fresh clone). */
export async function fetchGitSource(opts: {
  url: string;
  dataDir: string;
  ref?: string;
  slug?: string;
}): Promise<FetchedSource> {
  const slug = assertSafeSegment(opts.slug ?? slugify(opts.url));
  const target = path.resolve(opts.dataDir, slug);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(path.resolve(opts.dataDir), { recursive: true });
  const args = ["clone", "--depth", "1"];
  if (opts.ref) args.push("--branch", opts.ref);
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
  return { root: target, rev };
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

/** Synchronous git fetch (oma marketplace / addMarketplace uses a sync
 *  install path; the async variant above is for backend skill-pack). */
export function fetchGitSourceSync(opts: {
  url: string;
  dataDir: string;
  ref?: string;
  slug?: string;
}): FetchedSource {
  const slug = assertSafeSegment(opts.slug ?? slugify(opts.url));
  const target = path.resolve(opts.dataDir, slug);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(path.resolve(opts.dataDir), { recursive: true });
  const args = ["clone", "--depth", "1"];
  if (opts.ref) args.push("--branch", opts.ref);
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
  return { root: target, rev };
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
