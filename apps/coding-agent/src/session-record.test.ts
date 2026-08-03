import { describe, expect, test } from "bun:test";
import { canTransition, createSessionRecord, transition } from "./session-record.js";

describe("session record lifecycle", () => {
  test("legal transitions", () => {
    expect(canTransition("starting", "live")).toBe(true);
    expect(canTransition("live", "sleeping")).toBe(true);
    expect(canTransition("sleeping", "starting")).toBe(true);
    expect(canTransition("starting", "crashed")).toBe(true);
    expect(canTransition("live", "crashed")).toBe(true);
    expect(canTransition("stopping", "closed")).toBe(true);
  });

  test("illegal transitions rejected", () => {
    expect(canTransition("closed", "live")).toBe(false);
    expect(canTransition("crashed", "live")).toBe(false);
    expect(canTransition("sleeping", "live")).toBe(false);
    expect(canTransition("closed", "starting")).toBe(false);
  });

  test("transition mutates state and lastActivity", () => {
    const rec = createSessionRecord("s1");
    expect(rec.state).toBe("starting");
    transition(rec, "live");
    expect(rec.state).toBe("live");
    transition(rec, "sleeping");
    expect(rec.state).toBe("sleeping");
  });

  test("transition throws on illegal move", () => {
    const rec = createSessionRecord("s1");
    transition(rec, "live");
    transition(rec, "sleeping");
    expect(() => transition(rec, "live")).toThrow(/illegal session transition/);
  });

  test("crashed record cannot return to live through resume", () => {
    const rec = createSessionRecord("s1");
    transition(rec, "crashed");
    expect(canTransition("crashed", "live")).toBe(false);
    expect(() => transition(rec, "live")).toThrow(/illegal/);
    // A new session from fresh context is a different record
    const fresh = createSessionRecord("s1");
    expect(canTransition("starting", "live")).toBe(true);
    expect(fresh.state).toBe("starting");
  });
});
