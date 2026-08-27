import { describe, expect, test } from "bun:test";
import { computeNext } from "./engine.js";
import { parseWorkflow } from "./parse.js";

function branchDef() {
  return parseWorkflow({
    version: 1,
    id: "wf",
    nodes: [
      { id: "start", type: "start" },
      { id: "a", type: "script", code: "x", output: { severity: "string" } },
      { id: "done", type: "end", status: "success" },
      { id: "abort", type: "end", status: "failure" },
    ],
    edges: [
      { from: "start", to: "a" },
      { from: "a", to: "done", when: { "!=": [{ var: "a.output.severity" }, "critical"] } },
      { from: "a", to: "abort", when: { "==": [{ var: "a.output.severity" }, "critical"] } },
    ],
  });
}

describe("computeNext", () => {
  test("first step runs start with trigger input", () => {
    const step = computeNext(branchDef(), {
      completions: [],
      store: {},
      trigger: { issueUrl: "u" },
    });
    if (step.kind !== "run") throw new Error("expected run");
    expect(step.ready).toHaveLength(1);
    expect(step.ready[0]!.node.id).toBe("start");
    expect(step.ready[0]!.input).toEqual({ issueUrl: "u" });
    expect(step.ready[0]!.provenance).toEqual({ issueUrl: "trigger" });
  });

  test("terminal when end ready", () => {
    const step = computeNext(branchDef(), {
      completions: [
        { nodeId: "start", order: 0, output: {}, routedTo: ["a"] },
        { nodeId: "a", order: 1, output: { severity: "high" }, routedTo: ["done"] },
      ],
      store: {},
      trigger: {},
    });
    expect(step).toEqual({ kind: "terminal", exit: "success" });
  });

  test("condition routes to failure exit", () => {
    const step = computeNext(branchDef(), {
      completions: [
        { nodeId: "start", order: 0, output: {}, routedTo: ["a"] },
        { nodeId: "a", order: 1, output: { severity: "critical" }, routedTo: ["abort"] },
      ],
      store: {},
      trigger: {},
    });
    expect(step).toEqual({ kind: "terminal", exit: "failure" });
  });

  test("AND-join waits for both branches", () => {
    const def = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "script", code: "x" },
        { id: "b", type: "script", code: "x" },
        { id: "join", type: "script", code: "x" },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "start", to: "b" },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "join", to: "done" },
      ],
    });
    const afterA = computeNext(def, {
      completions: [
        { nodeId: "start", order: 0, output: {}, routedTo: ["a", "b"] },
        { nodeId: "a", order: 1, output: {}, routedTo: ["join"] },
      ],
      store: {},
      trigger: {},
    });
    if (afterA.kind === "idle") throw new Error("expected run");
    expect(afterA.kind).toBe("run");
    expect(afterA.ready.map((r) => r.node.id)).toEqual(["b"]);
    const afterBoth = computeNext(def, {
      completions: [
        { nodeId: "start", order: 0, output: {}, routedTo: ["a", "b"] },
        { nodeId: "a", order: 1, output: {}, routedTo: ["join"] },
        { nodeId: "b", order: 2, output: {}, routedTo: ["join"] },
      ],
      store: {},
      trigger: {},
    });
    if (afterBoth.kind !== "run") throw new Error("expected run");
    expect(afterBoth.ready.map((r) => r.node.id)).toEqual(["join"]);
  });

  test("idle when no outgoing condition matched", () => {
    const def = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "script", code: "x" },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "done", when: { "==": [{ var: "a.output.go" }, true] } },
      ],
    });
    const step = computeNext(def, {
      completions: [
        { nodeId: "start", order: 0, output: {}, routedTo: ["a"] },
        { nodeId: "a", order: 1, output: { go: false }, routedTo: [] },
      ],
      store: {},
      trigger: {},
    });
    expect(step).toEqual({ kind: "idle" });
  });

  test("node input defaults fill missing keys only", () => {
    const def = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "script", code: "x", input: { level: "low" } },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "done" },
      ],
    });
    const step = computeNext(def, {
      completions: [{ nodeId: "start", order: 0, output: { level: "high" }, routedTo: ["a"] }],
      store: {},
      trigger: {},
    });
    if (step.kind !== "run") throw new Error("expected run");
    expect(step.ready[0]!.input).toEqual({ level: "high" });
  });
});
