import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

/** Workspace sandbox enforces that all file access stays within an allowed root. */
export class WorkspaceSandbox {
  readonly root: string;

  constructor(root: string) {
    this.root = realpathSync(root);
  }

  /** Validate an existing path is within the sandbox. */
  validate(target: string): string {
    const resolved = this.resolve(target);
    if (!resolved.startsWith(`${this.root}/`) && resolved !== this.root) {
      throw new WorkspaceEscapeError(target, this.root);
    }
    // Check realpath for existing files to catch symlink escapes
    if (existsSync(resolved)) {
      const real = realpathSafe(resolved);
      if (real && !real.startsWith(`${this.root}/`) && real !== this.root) {
        throw new WorkspaceEscapeError(target, this.root);
      }
    }
    return resolved;
  }

  /** Validate a new path for creation. Walks up to the nearest existing
   *  parent and checks its realpath is within root. This catches cases
   *  where an intermediate directory is a symlink pointing outside. */
  validateNew(target: string): string {
    const resolved = this.resolve(target);
    if (!resolved.startsWith(`${this.root}/`) && resolved !== this.root) {
      throw new WorkspaceEscapeError(target, this.root);
    }
    // Walk up to find nearest existing parent
    let checkPath = resolved;
    const tried: string[] = [];
    while (checkPath !== this.root && checkPath !== "/") {
      if (existsSync(checkPath)) break;
      tried.push(checkPath);
      const idx = checkPath.lastIndexOf("/");
      if (idx <= 0) break;
      checkPath = checkPath.slice(0, idx);
    }
    // Check realpath of the nearest existing ancestor
    const real = realpathSafe(checkPath);
    if (!real || (!real.startsWith(`${this.root}/`) && real !== this.root)) {
      throw new WorkspaceEscapeError(target, this.root);
    }
    return resolved;
  }

  /** Check a command's cwd is within the sandbox. */
  validateCwd(cwd: string): string {
    const resolved = this.resolve(cwd);
    const real = realpathSafe(resolved);
    if (!real || (!real.startsWith(`${this.root}/`) && real !== this.root)) {
      throw new WorkspaceEscapeError(cwd, this.root);
    }
    return real;
  }

  private resolve(target: string): string {
    const normalized = normalize(target);
    if (isAbsolute(normalized)) return resolve(normalized);
    return resolve(this.root, normalized);
  }

  private parsePath(p: string): { dir: string; base: string } {
    const lastSep = p.lastIndexOf("/");
    return lastSep >= 0
      ? { dir: p.slice(0, lastSep), base: p.slice(lastSep + 1) }
      : { dir: ".", base: p };
  }
}

export class WorkspaceEscapeError extends Error {
  readonly path: string;
  readonly root: string;
  constructor(path: string, root: string) {
    super(`Path "${path}" escapes workspace root "${root}"`);
    this.name = "WorkspaceEscapeError";
    this.path = path;
    this.root = root;
  }
}

function realpathSafe(p: string): string | null {
  try {
    return existsSync(p) ? realpathSync(p) : null;
  } catch {
    return null;
  }
}
