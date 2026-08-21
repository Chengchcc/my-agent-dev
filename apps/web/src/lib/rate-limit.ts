/** F3: in-memory per-key failure limiter (coarse login throttle).
 *  Process-local by design — restart resets the counters, which is the
 *  correct trade for a single-instance product. */
export function createRateLimiter(opts: { maxFailures: number; lockMs: number }) {
  const entries = new Map<string, { count: number; lockedUntil: number }>();

  const prune = (key: string, now: number): void => {
    const e = entries.get(key);
    if (e && e.lockedUntil > 0 && e.lockedUntil <= now) entries.delete(key);
  };

  return {
    /** True while the key is locked (failed too often recently). */
    locked(key: string, now = Date.now()): boolean {
      prune(key, now);
      return (entries.get(key)?.lockedUntil ?? 0) > now;
    },
    /** Record a failure; returns true when this failure trips the lock. */
    fail(key: string, now = Date.now()): boolean {
      prune(key, now);
      const e = entries.get(key);
      const count = (e?.count ?? 0) + 1;
      if (count >= opts.maxFailures) {
        entries.set(key, { count: 0, lockedUntil: now + opts.lockMs });
        return true;
      }
      entries.set(key, { count, lockedUntil: 0 });
      return false;
    },
    /** Successful authentication clears the failure counter. */
    reset(key: string): void {
      entries.delete(key);
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
