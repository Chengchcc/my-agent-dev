import { describe, expect, test } from "bun:test";
import { appendThinking, appendTransient, type TransientMap } from "./transient-reducer";

describe("transient-reducer ordered interleave", () => {
  test("appendTransient/appendThinking record arrival order", () => {
    let state: TransientMap = {};
    state = appendThinking(state, "r1", "ag1", "think one ");
    state = appendTransient(state, "r1", "ag1", "say this ");
    state = appendThinking(state, "r1", "ag1", "think two");
    expect(state.r1?.text).toBe("say this ");
    expect(state.r1?.thinking).toBe("think one think two");
    expect(state.r1?.ordered).toEqual([
      { type: "thinking", text: "think one " },
      { type: "text", text: "say this " },
      { type: "thinking", text: "think two" },
    ]);
  });

  test("only text deltas keep text/thinking split correct", () => {
    let state: TransientMap = {};
    state = appendTransient(state, "r1", "ag1", "a");
    state = appendTransient(state, "r1", "ag1", "b");
    state = appendThinking(state, "r1", "ag1", "x");
    expect(state.r1?.text).toBe("ab");
    expect(state.r1?.thinking).toBe("x");
    expect(state.r1?.ordered?.map((b) => b.type)).toEqual(["text", "text", "thinking"]);
  });
});
