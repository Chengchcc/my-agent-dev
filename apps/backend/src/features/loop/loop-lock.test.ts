import { describe, expect, test } from "bun:test";
import { createLoopLockRegistry } from "./loop-lock.js";

describe("createLoopLockRegistry", () => {
  test("serializes concurrent withLoopLock calls on the same loopId", async () => {
    const lock = createLoopLockRegistry();
    let active = 0;
    let maxConcurrent = 0;

    const work = async () => {
      await lock.withLoopLock("loop-1", async () => {
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        // Real delay, not fake timers: the whole point is to hold fn open so
        // concurrent callers WOULD overlap if the lock were broken. A
        // microtask-only rendezvous can't detect that (each fn would finish
        // before the next waiter resumes).
        await Bun.sleep(10);
        active--;
      });
    };

    await Promise.all([work(), work(), work()]);
    expect(maxConcurrent).toBe(1);
  });

  test("releases the lock after a failed fn, letting the next waiter run", async () => {
    const lock = createLoopLockRegistry();
    const order: string[] = [];

    await Promise.all([
      lock
        .withLoopLock("loop-1", async () => {
          order.push("first");
          throw new Error("boom");
        })
        .catch(() => undefined),
      lock.withLoopLock("loop-1", async () => {
        order.push("second");
      }),
    ]);
    expect(order).toEqual(["first", "second"]);
  });
});
