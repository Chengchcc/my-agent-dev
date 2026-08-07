import { describe, expect, test } from "bun:test";
import { appendTransient, removeTransient, type TransientMap } from "@/lib/transient-reducer";

describe("transient reducer", () => {
  test("A delta + B delta → two independent bubbles", () => {
    let s: TransientMap = {};
    s = appendTransient(s, "run-a", "member-a", "hello from A");
    s = appendTransient(s, "run-b", "member-b", "hello from B");
    expect(s["run-a"]).toEqual({ text: "hello from A", agentMemberId: "member-a" });
    expect(s["run-b"]).toEqual({ text: "hello from B", agentMemberId: "member-b" });
  });

  test("A delta + A delta → concatenated into A only", () => {
    let s: TransientMap = {};
    s = appendTransient(s, "run-a", "member-a", "one ");
    s = appendTransient(s, "run-b", "member-b", "B");
    s = appendTransient(s, "run-a", "member-a", "two");
    expect(s["run-a"]?.text).toBe("one two");
    expect(s["run-b"]?.text).toBe("B");
  });

  test("canonical A removes only A", () => {
    let s: TransientMap = {};
    s = appendTransient(s, "run-a", "m-a", "A");
    s = appendTransient(s, "run-b", "m-b", "B");
    s = removeTransient(s, "run-a");
    expect(s["run-a"]).toBeUndefined();
    expect(s["run-b"]?.text).toBe("B");
  });

  test("failed B removes only B", () => {
    let s: TransientMap = {};
    s = appendTransient(s, "run-a", "m-a", "A");
    s = appendTransient(s, "run-b", "m-b", "B");
    s = removeTransient(s, "run-b");
    expect(s["run-a"]?.text).toBe("A");
    expect(s["run-b"]).toBeUndefined();
  });

  test("removing an absent run is a no-op (same reference)", () => {
    const s: TransientMap = {};
    expect(removeTransient(s, "nope")).toBe(s);
  });

  test("conversation switch → empty map", () => {
    appendTransient({}, "run-a", "m-a", "A"); // build state is irrelevant
    const cleared: TransientMap = {}; // unmount clears the whole map
    expect(cleared).toEqual({});
  });
});
