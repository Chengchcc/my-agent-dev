import { describe, expect, test } from "bun:test";
import { toEditorGraph } from "./graph-model.js";
import { parseWorkflow } from "../parse.js";

describe("toEditorGraph", () => {
  test("maps nodes and edges", () => {
    const def = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "agent", agentId: "ag-1" },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "done", when: { "==": [{ var: "a.output.ok" }, true] } },
      ],
    });
    const g = toEditorGraph(def);
    expect(g.nodes).toHaveLength(3);
    expect(g.nodes.find((n) => n.id === "a")!.label).toBe("Agent: ag-1");
    expect(g.edges).toHaveLength(2);
    expect(g.edges[1]!.label).toBe(JSON.stringify({ "==": [{ var: "a.output.ok" }, true] }));
  });
});
