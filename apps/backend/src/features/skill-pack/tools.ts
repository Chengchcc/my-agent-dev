import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { buildSkillIndex } from "@my-agent-team/plugin-progressive-skill";

// ─── validation helpers ──────────────────────────────────────────────────────────

export function assertSafeEntry(name: string): void {
  if (!name || name.startsWith("/") || name.includes("..") || name.includes("\\")) {
    throw new Error(`Unsafe path entry: ${name}`);
  }
}

export async function validatePackDir(cwd: string, targetDir: string): Promise<boolean> {
  const skills = buildSkillIndex([resolve(cwd, targetDir)]);
  return skills.length > 0;
}

export function computeDirChecksum(cwd: string, dir: string): string {
  const hash = createHash("sha256");
  function walk(d: string) {
    const full = resolve(cwd, d);
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const p = resolve(full, entry.name);
      if (entry.isFile()) {
        hash.update(readFileSync(p));
      } else if (entry.isDirectory()) {
        walk(resolve(full, entry.name));
      }
    }
  }
  walk(dir);
  return hash.digest("hex");
}

/**
 * Validate extracted zip entries: reject symlinks (not allowed in skill packs)
 * and ensure no path escapes the extract root via ../ or absolute path.
 * Called BEFORE atomic rename from temp to the final targetDir.
 */
export function validateExtractedEntries(root: string, dir: string): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    const stat = lstatSync(fullPath);

    if (stat.isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed in skill packs: ${entry.name}`);
    }

    // For regular files/dirs, verify realpath is within root. BOTH sides
    // are canonicalized: the extract root may itself be a symlink (e.g.
    // macOS /var -> /private/var), which would otherwise false-positive.
    const real = realpathSync(fullPath);
    const normalizedRoot = realpathSync(root);
    if (!real.startsWith(`${normalizedRoot}/`) && real !== normalizedRoot) {
      throw new Error(`Path escape detected: ${entry.name} → ${real}`);
    }

    if (entry.isDirectory()) {
      validateExtractedEntries(root, fullPath);
    }
  }
}
