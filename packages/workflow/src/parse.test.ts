import { describe, expect, test } from "bun:test";
import { parseWorkflow, WorkflowParseError } from "./parse.js";

const base = {
  version: 1,
  id: "wf",
  nodes: [
    { id: "start", type: "start" },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [{ from: "start", to: "done" }],
};

describe("parseWorkflow", () => {
  test("valid minimal", () => {
    const def = parseWorkflow(base);
    expect(def.id).toBe("wf");
    expect(def.nodes).toHaveLength(2);
  });

  test("rejects unknown node type", () => {
    expect(() => parseWorkflow({ ...base, nodes: [{ id: "x", type: "mystery" }] })).toThrow(
      WorkflowParseError,
    );
  });

  test("rejects duplicate ids", () => {
    expect(() =>
      parseWorkflow({
        ...base,
        nodes: [...base.nodes, { id: "start", type: "script", code: "x" }],
      }),
    ).toThrow(/duplicate node id/);
  });

  test("rejects agent without agentId or model+prompt", () => {
    expect(() =>
      parseWorkflow({ ...base, nodes: [...base.nodes, { id: "a", type: "agent" }] }),
    ).toThrow(/agent requires/);
  });

  test("rejects edge to unknown node", () => {
    expect(() => parseWorkflow({ ...base, edges: [{ from: "start", to: "nope" }] })).toThrow(
      /not a node id/,
    );
  });

  test("rejects cycle", () => {
    expect(() =>
      parseWorkflow({
        ...base,
        edges: [
          { from: "start", to: "done" },
          { from: "done", to: "start" },
        ],
      }),
    ).toThrow(/cycle/);
  });

  test("normalizes valid agent, script runtime and human", () => {
    const def = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "agent", agentId: "ag-1" },
        { id: "s", type: "script", code: "x", runtime: "bun" },
        {
          id: "h",
          type: "human",
          question: "ok?",
          form: { level: { type: "enum", options: ["a", "b"] } },
        },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "s" },
        { from: "s", to: "h" },
        { from: "h", to: "done" },
      ],
    });
    expect(def.nodes[1]).toMatchObject({ type: "agent", agentId: "ag-1" });
    expect(def.nodes[2]).toMatchObject({ type: "script", code: "x", runtime: "bun" });
    expect(def.nodes[3]).toMatchObject({
      type: "human",
      form: { level: { type: "enum", options: ["a", "b"] } },
    });
  });
});
