import { describe, expect, test } from "bun:test";
import { createRateLimiter } from "@/lib/rate-limit";

describe("createRateLimiter", () => {
  test("locks after maxFailures and clears after the window", () => {
    const limiter = createRateLimiter({ maxFailures: 3, lockMs: 1000 });
    const t0 = 0;
    expect(limiter.fail("ip-1", t0)).toBe(false);
    expect(limiter.fail("ip-1", t0 + 10)).toBe(false);
    expect(limiter.locked("ip-1", t0 + 20)).toBe(false);
    expect(limiter.fail("ip-1", t0 + 30)).toBe(true);
    expect(limiter.locked("ip-1", t0 + 40)).toBe(true);
    // Window expires (lock ends at t0+30+1000): unlocked + counter pruned.
    expect(limiter.locked("ip-1", t0 + 1031)).toBe(false);
  });

  test("keys are independent and reset clears a key", () => {
    const limiter = createRateLimiter({ maxFailures: 2, lockMs: 60_000 });
    limiter.fail("a", 0);
    expect(limiter.fail("a", 10)).toBe(true);
    expect(limiter.locked("b", 10)).toBe(false);
    limiter.reset("a");
    expect(limiter.locked("a", 20)).toBe(false);
  });
});
