import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fetchGitSource, materializeZipSource } from "@chengchenccc/source-fetch";
import type { KnowledgePackRow } from "./entities.js";
import type { KnowledgePackPort } from "./ports.js";

/** Lean install (ADR 0022): builtin dir copy / git clone / zip extract
 *  into <dataDir>/knowledge/<packId>. Knowledge packs have no internal
 *  layout constraint (any files). git/zip go through @chengchenccc/source-fetch
 *  so they get the same path-escape/symlink guard as skill-packs. */

export interface KnowledgeInstallDeps {
  dataDir: string;
  port: KnowledgePackPort;
  /** Builtin pack root: <name> directory copied wholesale. */
  builtinRoot?: string;
  zipBuffer?: Buffer;
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
  });
}

export function knowledgeInstallRoot(dataDir: string, packId: string): string {
  return join(dataDir, "knowledge", packId);
}

/** Kick off a pack install and drive it to a terminal status. Simple
 *  sequential install (ponytail: packs install rarely; one at a time). */
export async function installKnowledgePack(
  deps: KnowledgeInstallDeps,
  input: {
    id: string;
    name: string;
    description: string;
    sourceKind: "builtin" | "git" | "zip";
    sourceUrl: string | null;
    versionRef: string | null;
  },
): Promise<KnowledgePackRow> {
  const now = Date.now();
  const row = deps.port.create({
    id: input.id,
    name: input.name,
    description: input.description,
    sourceKind: input.sourceKind,
    sourceUrl: input.sourceUrl,
    versionRef: input.versionRef,
    sourceRev: null,
    installedRef: null,
    status: "installing",
    error: null,
    createdAt: now,
    updatedAt: now,
  });

  let target = knowledgeInstallRoot(deps.dataDir, input.id);
  let sourceRev: string | null = null;
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  try {
    if (input.sourceKind === "builtin") {
      const src = deps.builtinRoot ? join(deps.builtinRoot, input.name) : null;
      if (!src || !existsSync(src)) throw new Error(`builtin pack not found: ${input.name}`);
      const res = await run("cp", ["-a", `${src}/.`, target], "/");
      if (res.exitCode !== 0) throw new Error(`copy failed: ${res.stderr.slice(0, 200)}`);
    } else if (input.sourceKind === "git") {
      if (!input.sourceUrl) throw new Error("sourceUrl required for git packs");
      const fetched = await fetchGitSource({
        url: input.sourceUrl,
        dataDir: join(deps.dataDir, "knowledge"),
        slug: input.id,
        ...(input.versionRef ? { ref: input.versionRef } : {}),
      });
      target = fetched.root;
      sourceRev = fetched.rev;
    } else {
      const buf = deps.zipBuffer;
      if (!buf || buf.length === 0) throw new Error("zip upload missing for zip packs");
      const fetched = await materializeZipSource({
        buffer: buf,
        dataDir: join(deps.dataDir, "knowledge"),
        slug: input.id,
      });
      target = fetched.root;
      sourceRev = fetched.rev;
    }
    return deps.port.update(input.id, {
      status: "ready",
      installedRef: target,
      sourceRev,
      error: null,
      updatedAt: Date.now(),
    })!;
  } catch (err) {
    return (
      deps.port.update(input.id, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        updatedAt: Date.now(),
      }) ?? row
    );
  }
}

/** File-list index of one pack (ADR 0022: the bridge writes index.md).
 *  Accepts the minimal shape the bridge has at reconcile time. */
export function knowledgePackIndex(pack: {
  name: string;
  description: string;
  installedRef: string | null;
}): string {
  const root = pack.installedRef;
  if (!root || !existsSync(root)) return "";
  const lines: string[] = [`## ${pack.name}`, "", pack.description, ""];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || lines.length > 250) return;
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git") continue;
      const full = join(dir, name);
      const rel = full.slice(root.length + 1);
      try {
        if (statSync(full).isDirectory()) {
          lines.push(`${"  ".repeat(depth)}- ${rel}/`);
          walk(full, depth + 1);
        } else {
          lines.push(`${"  ".repeat(depth)}- ${rel}`);
        }
      } catch {
        /* skip unreadable */
      }
    }
  };
  walk(root, 0);
  return lines.join("\n");
}
