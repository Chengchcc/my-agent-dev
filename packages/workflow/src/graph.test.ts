import { describe, expect, test } from "bun:test";
import { mergeInputs, routeOutgoing, topoSort } from "./graph.js";
import { parseWorkflow } from "./parse.js";

const def = parseWorkflow({
  version: 1,
  id: "wf",
  nodes: [
    { id: "start", type: "start" },
    { id: "a", type: "script", code: "export default async () => ({})" },
    { id: "b", type: "script", code: "export default async () => ({})" },
    { id: "join", type: "script", code: "export default async () => ({})" },
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

describe("graph", () => {
  test("topoSort", () => {
    expect(topoSort(def)).toEqual(["start", "a", "b", "join", "done"]);
  });

  test("routeOutgoing unconditional", () => {
    expect(routeOutgoing("start", def, [{ nodeId: "start", order: 0, routedTo: [] }], {})).toEqual([
      "a",
      "b",
    ]);
  });

  test("routeOutgoing respects when and nextNode override", () => {
    const condDef = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "script", code: "x" },
        { id: "b", type: "script", code: "x" },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "b", when: { "==": [{ var: "a.output.go" }, true] } },
        { from: "a", to: "done", when: { "!=": [{ var: "a.output.go" }, true] } },
      ],
    });
    const gone = [
      { nodeId: "start", order: 0, routedTo: ["a"] },
      { nodeId: "a", order: 1, output: { go: false }, routedTo: ["done"] },
    ];
    expect(routeOutgoing("a", condDef, gone, {})).toEqual(["done"]);
    const overridden = [
      { nodeId: "start", order: 0, routedTo: ["a"] },
      { nodeId: "a", order: 1, output: { go: true, nextNode: "b" }, routedTo: ["b"] },
    ];
    expect(routeOutgoing("a", condDef, overridden, {})).toEqual(["b"]);
  });

  test("routeOutgoing throws on nextNode to non-edge target", () => {
    const badDef = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "script", code: "x" },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "done" },
      ],
    });
    expect(() =>
      routeOutgoing(
        "a",
        badDef,
        [{ nodeId: "a", order: 0, output: { nextNode: "nope" }, routedTo: [] }],
        {},
      ),
    ).toThrow(/not an edge target/);
  });

  test("routeOutgoing uses explicit sourceOutput when node not yet in completions", () => {
    const condDef = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "script", code: "x" },
        { id: "done", type: "end", status: "success" },
        { id: "abort", type: "end", status: "failure" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "done", when: { "==": [{ var: "a.output.go" }, true] } },
        { from: "a", to: "abort", when: { "!=": [{ var: "a.output.go" }, true] } },
      ],
    });
    const before = [{ nodeId: "start", order: 0, routedTo: ["a"] }];
    expect(routeOutgoing("a", condDef, before, {}, { go: true })).toEqual(["done"]);
    expect(routeOutgoing("a", condDef, before, {}, { go: false })).toEqual(["abort"]);
  });

  test("mergeInputs later wins with provenance", () => {
    const result = mergeInputs(
      [
        { nodeId: "a", order: 0, output: { x: 1, y: "a" }, routedTo: [] },
        { nodeId: "b", order: 1, output: { y: "b" }, routedTo: [] },
      ],
      { z: "store" },
      { t: "trigger" },
    );
    expect(result.input).toEqual({ t: "trigger", z: "store", x: 1, y: "b" });
    expect(result.provenance).toEqual({ t: "trigger", z: "store", x: "a", y: "b" });
  });
});
