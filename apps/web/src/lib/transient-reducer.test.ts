import { describe, expect, test } from "bun:test";
import { markTransientError, pushTransientNotice } from "./transient-reducer";

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

describe("pushTransientNotice", () => {
  test("creates a bubble with the notice and keeps later text appends working", () => {
    const next = pushTransientNotice({}, "r1", "m1", 'stream rule "x" matched');
    expect(next.r1?.notices).toEqual(['stream rule "x" matched']);
  });

  test("caps at 5 notices per run", () => {
    let state = {};
    for (let i = 0; i < 8; i++) state = pushTransientNotice(state, "r1", "m1", `n${i}`);
    expect(state.r1?.notices).toEqual(["n3", "n4", "n5", "n6", "n7"]);
  });
});
