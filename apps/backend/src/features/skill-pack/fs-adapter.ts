import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentFsLike } from "./agent-fs-like.js";

/**
 * Create a cwd-locked filesystem adapter.
 * All paths are resolved relative to cwd and validated to be within it.
 * Uses path segment check (full === cwd || full.startsWith(cwd + sep)) to
 * prevent false matches (e.g. /data/skill-packs-evil vs /data/skill-packs).
 */
export function nodeFsAdapter(cwd: string): AgentFsLike {
  const sep = cwd.includes("\\") ? "\\" : "/";

  function inCwd(full: string): boolean {
    return full === cwd || full.startsWith(cwd + sep);
  }

  return {
    async read(path: string) {
      try {
        const full = resolve(cwd, path);
        if (!inCwd(full)) return null;
        return readFileSync(full, "utf-8");
      } catch {
        return null;
      }
    },
    async write(path: string, content: string) {
      const full = resolve(cwd, path);
      if (!inCwd(full)) throw new Error("Path escapes workspace");
      mkdirSync(resolve(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf-8");
    },
    async list(dir: string) {
      try {
        const full = resolve(cwd, dir);
        if (!inCwd(full)) return [];
        return readdirSync(full, { withFileTypes: true }).map((d) => d.name);
      } catch {
        return [];
      }
    },
    async stat(path: string) {
      try {
        const full = resolve(cwd, path);
        if (!inCwd(full)) return null;
        const s = statSync(full);
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    },
    async exists(path: string) {
      try {
        const full = resolve(cwd, path);
        return inCwd(full) && existsSync(full);
      } catch {
        return false;
      }
    },
    async mkdirp(path: string) {
      const full = resolve(cwd, path);
      if (!inCwd(full)) throw new Error("Path escapes workspace");
      mkdirSync(full, { recursive: true });
    },
  };
}
