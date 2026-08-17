import { describe, expect, test } from "bun:test";
import { createRunTokenRegistry } from "./run-token-registry.js";

describe("RunTokenRegistry", () => {
  test("mint → validate round-trips the bound context", () => {
    const reg = createRunTokenRegistry();
    const token = reg.mint({ runId: "r1", agentId: "a1", exp: Date.now() + 60_000 });
    expect(reg.validate(token)).toMatchObject({ runId: "r1", agentId: "a1" });
  });

  test("revoke invalidates exactly that run's token (idempotent)", () => {
    const reg = createRunTokenRegistry();
    const t1 = reg.mint({ runId: "r1", agentId: "a1", exp: Date.now() + 60_000 });
    const t2 = reg.mint({ runId: "r2", agentId: "a1", exp: Date.now() + 60_000 });
    reg.revoke("r1");
    reg.revoke("r1");
    expect(reg.validate(t1)).toBeNull();
    expect(reg.validate(t2)).not.toBeNull();
  });

  test("tokens ignore wall-clock expiry (B2: lifecycle is revoke-at-settle)", () => {
    const reg = createRunTokenRegistry();
    const t = reg.mint({ runId: "r1", agentId: "a1", exp: Date.now() - 1 });
    // A long-running run must not silently lose product tools at a TTL
    // boundary; only revoke() (or a process restart) invalidates.
    expect(reg.validate(t)).toMatchObject({ runId: "r1" });
  });

  test("re-minting a runId invalidates its previous token", () => {
    const reg = createRunTokenRegistry();
    const t1 = reg.mint({ runId: "r1", agentId: "a1", exp: Date.now() + 60_000 });
    const t2 = reg.mint({ runId: "r1", agentId: "a1", exp: Date.now() + 60_000 });
    expect(t1).not.toBe(t2);
    expect(reg.validate(t1)).toBeNull();
    expect(reg.validate(t2)).not.toBeNull();
  });

  test("unknown tokens are null", () => {
    const reg = createRunTokenRegistry();
    expect(reg.validate("garbage")).toBeNull();
  });

  test("capacity guard throws instead of growing unbounded", () => {
    const reg = createRunTokenRegistry({ capacity: 2 });
    reg.mint({ runId: "r1", agentId: "a", exp: Date.now() + 60_000 });
    reg.mint({ runId: "r2", agentId: "a", exp: Date.now() + 60_000 });
    expect(() => reg.mint({ runId: "r3", agentId: "a", exp: Date.now() + 60_000 })).toThrow(
      /capacity/,
    );
  });
});
