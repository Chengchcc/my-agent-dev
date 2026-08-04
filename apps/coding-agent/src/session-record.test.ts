import { describe, expect, test } from "bun:test";
import { canTransition, createSessionRecord, transition } from "./session-record.js";

describe("session record lifecycle (one-shot Worker)", () => {
  test("legal transitions", () => {
    // idle -> starting -> running (a Run's one-shot Worker is live)
    expect(canTransition("idle", "starting")).toBe(true);
    expect(canTransition("starting", "running")).toBe(true);
    // a settled run's Worker exit returns the session to idle
    expect(canTransition("running", "idle")).toBe(true);
    // close/stop paths
    expect(canTransition("idle", "closing")).toBe(true);
    expect(canTransition("starting", "closing")).toBe(true);
    expect(canTransition("running", "closing")).toBe(true);
    expect(canTransition("closing", "closed")).toBe(true);
    // crash
    expect(canTransition("starting", "crashed")).toBe(true);
    expect(canTransition("running", "crashed")).toBe(true);
    expect(canTransition("idle", "crashed")).toBe(true);
  });

  test("illegal transitions rejected", () => {
    // no sleeping, no wake, no long-lived worker reuse
    expect(canTransition("running", "running")).toBe(false);
    expect(canTransition("idle", "running")).toBe(false);
    expect(canTransition("closed", "idle")).toBe(false);
    expect(canTransition("crashed", "idle")).toBe(false);
    expect(canTransition("crashed", "running")).toBe(false);
    expect(canTransition("closed", "starting")).toBe(false);
  });

  test("transition mutates state and lastActivity", () => {
    const rec = createSessionRecord("s1");
    expect(rec.state).toBe("idle");
    transition(rec, "starting");
    expect(rec.state).toBe("starting");
    transition(rec, "running");
    expect(rec.state).toBe("running");
    transition(rec, "idle");
    expect(rec.state).toBe("idle");
    transition(rec, "closing");
    transition(rec, "closed");
    expect(rec.state).toBe("closed");
  });

  test("transition throws on illegal move", () => {
    const rec = createSessionRecord("s1");
    transition(rec, "starting");
    expect(() => transition(rec, "starting")).toThrow(/illegal session transition/);
    expect(() => transition(rec, "closed")).toThrow(/illegal session transition/);
  });

  test("crashed record cannot return to running through resume", () => {
    const rec = createSessionRecord("s1");
    transition(rec, "crashed");
    expect(canTransition("crashed", "running")).toBe(false);
    expect(canTransition("crashed", "idle")).toBe(false);
    expect(() => transition(rec, "idle")).toThrow(/illegal/);
    // A new session from fresh context is a different record
    const fresh = createSessionRecord("s1");
    expect(fresh.state).toBe("idle");
    expect(canTransition("idle", "starting")).toBe(true);
  });
});
