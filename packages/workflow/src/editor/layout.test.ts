import { describe, expect, test } from "bun:test";
import { parseWorkflow } from "../parse.js";
import { layeredLayout } from "./layout.js";

describe("layeredLayout", () => {
  test("layers and positions", () => {
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
    const byId = new Map(layeredLayout(def).map((p) => [p.id, p]));
    expect(byId.get("start")!.layer).toBe(0);
    expect(byId.get("a")!.layer).toBe(1);
    expect(byId.get("b")!.layer).toBe(1);
    expect(byId.get("join")!.layer).toBe(2);
    expect(byId.get("done")!.layer).toBe(3);
    // Horizontal DAG: deeper layer → column advances right (x), siblings
    // within a layer stack vertically (y).
    expect(byId.get("done")!.x).toBeGreaterThan(byId.get("join")!.x);
    expect(byId.get("b")!.y).toBeGreaterThan(byId.get("a")!.y);
  });
});
