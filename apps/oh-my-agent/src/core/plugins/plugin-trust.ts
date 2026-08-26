import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../session/session-file.js";

export interface TrustRecord {
  readonly hash: string;
  readonly trustedAt: string;
}

export type TrustedPlugins = Map<string, TrustRecord>;

function trustedPath(): string {
  return join(agentDir(), "trusted-plugins.json");
}

/** Directory hash (spec): recursive sha256 over sorted (relpath, fileHash)
 *  pairs, excluding node_modules. */
export function computePluginHash(pluginRoot: string): string {
  const files: Array<{ rel: string; fileHash: string }> = [];
  const walk = (dir: string, prefix: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules") continue;
      const full = join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(full, rel);
      else if (ent.isFile()) {
        files.push({
          rel,
          fileHash: createHash("sha256").update(readFileSync(full)).digest("hex"),
        });
      }
    }
  };
  walk(pluginRoot, "");
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const aggregate = files.map((f) => `${f.rel}\0${f.fileHash}`).join("\n");
  return `sha256:${createHash("sha256").update(aggregate).digest("hex")}`;
}

/** Corrupt file = empty map (all untrusted) — never throws (spec failure
 *  semantics). */
export function readTrustedPlugins(): TrustedPlugins {
  try {
    const parsed = JSON.parse(readFileSync(trustedPath(), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return new Map();
    const out: TrustedPlugins = new Map();
    for (const [root, rec] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof rec === "object" &&
        rec !== null &&
        typeof (rec as Record<string, unknown>).hash === "string"
      ) {
        out.set(root, rec as TrustRecord);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

export function writeTrustedPlugins(map: TrustedPlugins): void {
  const obj: Record<string, TrustRecord> = {};
  for (const [root, rec] of map) obj[root] = rec;
  writeFileSync(trustedPath(), `${JSON.stringify(obj, null, 2)}\n`);
}

/** Record explicit user trust for a plugin root at its current hash. */
export function trustPlugin(pluginRoot: string): void {
  const map = readTrustedPlugins();
  map.set(pluginRoot, {
    hash: computePluginHash(pluginRoot),
    trustedAt: new Date().toISOString(),
  });
  writeTrustedPlugins(map);
}

/** Trust decision: approved only when the recorded hash matches the
 *  current content hash (any file change re-untrusts). */
export function isPluginTrusted(pluginRoot: string, trusted: TrustedPlugins): boolean {
  const rec = trusted.get(pluginRoot);
  return rec !== undefined && rec.hash === computePluginHash(pluginRoot);
}

/** Content hash of a single file (workspace .mcp.json gating). */
export function computeFileHash(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/** Record explicit user trust for a single file at its current hash. */
export function trustFile(path: string): void {
  const map = readTrustedPlugins();
  map.set(path, { hash: computeFileHash(path), trustedAt: new Date().toISOString() });
  writeTrustedPlugins(map);
}

/** File trust decision: recorded hash must match current content. */
export function isFileTrusted(path: string, trusted: TrustedPlugins): boolean {
  const rec = trusted.get(path);
  return rec !== undefined && rec.hash === computeFileHash(path);
}
