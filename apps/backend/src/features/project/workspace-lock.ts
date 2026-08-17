import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface WorkspaceLockRegistry {
  /** Serialize fn against every other withLock caller on the same root
   *  (after path normalization). Rejections in fn propagate; the lock is
   *  always released. */
  withLock<T>(root: string, fn: () => Promise<T>): Promise<T>;
  /** True while a withLock fn is executing on this root. */
  isLocked(root: string): boolean;
}

/** Normalize the lock key: realpath when the path exists (macOS /private,
 *  symlinked workspaces), resolved absolute otherwise. */
function lockKey(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

/** Per-worktree mutex shared by run dispatch, loop clean-start/reset and
 *  agent detach removal (ADR 0023 §5). One promise-chain tail per root;
 *  the chain entry is removed when the last waiter settles, so the map
 *  cannot grow across runs. */
export function createWorkspaceLockRegistry(): WorkspaceLockRegistry {
  /** root key → completion tail of the newest waiter (chained). */
  const tails = new Map<string, Promise<void>>();
  /** root keys whose fn is currently executing. */
  const live = new Set<string>();

  return {
    isLocked(root: string): boolean {
      return live.has(lockKey(root));
    },

    async withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
      const key = lockKey(root);
      const prev = tails.get(key) ?? Promise.resolve();
      const { promise: gate, resolve: open } = Promise.withResolvers<void>();
      const tail = prev.then(() => gate);
      tails.set(key, tail);
      await prev.catch(() => {
        /* a failed predecessor must not fail this waiter */
      });
      live.add(key);
      try {
        return await fn();
      } finally {
        live.delete(key);
        // Only drop the chain entry when no newer waiter replaced it.
        if (tails.get(key) === tail) tails.delete(key);
        open();
      }
    },
  };
}
