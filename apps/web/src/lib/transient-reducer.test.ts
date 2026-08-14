import { describe, expect, test } from "bun:test";
import { markTransientError } from "./transient-reducer";

describe("markTransientError", () => {
  test("attaches the error to an existing run, keeping its text", () => {
    const state = { r1: { text: "partial", thinking: "t", agentMemberId: "m1" } };
    const next = markTransientError(state, "r1", "m1", "spawn ENOENT");
    expect(next.r1).toEqual({
      text: "partial",
      thinking: "t",
      agentMemberId: "m1",
      error: "spawn ENOENT",
    });
  });

  test("creates an empty bubble for a run that failed before any text", () => {
    const next = markTransientError({}, "r2", "m1", "catalog down");
    expect(next.r2).toEqual({ text: "", thinking: "", agentMemberId: "m1", error: "catalog down" });
  });
});
