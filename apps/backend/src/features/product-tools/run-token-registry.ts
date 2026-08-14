import { createHash, randomBytes } from "node:crypto";

export interface RunTokenContext {
  readonly runId: string;
  readonly agentId: string;
  readonly exp: number;
}

export interface RunTokenRegistry {
  mint(ctx: RunTokenContext): string;
  validate(token: string): RunTokenContext | null;
  revoke(runId: string): void;
}

const DEFAULT_CAPACITY = 10_000;

/** Process-internal per-run bearer registry. Keys are SHA-256 of the token
 *  (plaintext never retained in the Map), so a heap snapshot cannot leak a
 *  usable credential. One live token per runId — re-minting supersedes. */
export function createRunTokenRegistry(opts: { capacity?: number } = {}): RunTokenRegistry {
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  /** sha256(token) → context */
  const byHash = new Map<string, RunTokenContext>();
  /** runId → sha256(token) */
  const byRun = new Map<string, string>();

  const keyOf = (token: string): string => createHash("sha256").update(token).digest("hex");

  return {
    mint(ctx) {
      if (byHash.size >= capacity) {
        throw new Error(`run-token registry at capacity (${capacity}); active runs not settling?`);
      }
      const prev = byRun.get(ctx.runId);
      if (prev !== undefined) {
        byHash.delete(prev);
        byRun.delete(ctx.runId);
      }
      const token = randomBytes(32).toString("base64url");
      byHash.set(keyOf(token), ctx);
      byRun.set(ctx.runId, keyOf(token));
      return token;
    },
    validate(token) {
      const hash = keyOf(token);
      const ctx = byHash.get(hash);
      if (!ctx) return null;
      if (Date.now() > ctx.exp) {
        byHash.delete(hash);
        byRun.delete(ctx.runId);
        return null;
      }
      return ctx;
    },
    revoke(runId) {
      const hash = byRun.get(runId);
      if (hash === undefined) return;
      byRun.delete(runId);
      byHash.delete(hash);
    },
  };
}
