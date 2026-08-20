/** Per-loop mutex serializing the loop state machine's load -> reducer ->
 *  save cycle across ALL entry points (cron tick, HTTP run, HTTP review).
 *  Without it a review during a long generator tick saves a stale snapshot
 *  over the tick's result (last-writer-wins on loop_item).
 *
 *  Same promise-chain pattern as project/workspace-lock.ts, keyed by the
 *  plain loopId (no path normalization needed). */
export interface LoopLockRegistry {
  withLoopLock<T>(loopId: string, fn: () => Promise<T>): Promise<T>;
}

export function createLoopLockRegistry(): LoopLockRegistry {
  /** loopId -> completion tail of the newest waiter (chained). */
  const tails = new Map<string, Promise<void>>();

  return {
    async withLoopLock<T>(loopId: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(loopId) ?? Promise.resolve();
      const { promise: gate, resolve: open } = Promise.withResolvers<void>();
      const tail = prev.then(() => gate);
      tails.set(loopId, tail);
      await prev.catch(() => {
        /* a failed predecessor must not fail this waiter */
      });
      try {
        return await fn();
      } finally {
        // Only drop the chain entry when no newer waiter replaced it.
        if (tails.get(loopId) === tail) tails.delete(loopId);
        open();
      }
    },
  };
}
