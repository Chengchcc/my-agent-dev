import { describe, expect, test } from "bun:test";
import { createNodeRunners } from "./node-runners.js";

const store = { get: () => undefined, set: async () => {}, delete: async () => {} };

describe("createNodeRunners", () => {
  test("script node executes TS default export", async () => {
    const runners = createNodeRunners({ dataDir: ".backend-data/workflow-scripts" });
    const out = await runners.script.run(
      { id: "s", type: "script", code: "export default async (ctx) => ({ sent: ctx.input.x })" },
      { input: { x: 1 }, store, context: { executionId: "e", nodeId: "s", workflowId: "wf" } },
    );
    expect(out.output).toEqual({ sent: 1 });
  });

  test("script node times out", async () => {
    const runners = createNodeRunners({ dataDir: ".backend-data/workflow-scripts" });
    await expect(
      runners.script.run(
        {
          id: "s",
          type: "script",
          code: "export default async () => new Promise(() => {})",
          timeoutMs: 50,
        },
        { input: {}, store, context: { executionId: "e", nodeId: "s", workflowId: "wf" } },
      ),
    ).rejects.toThrow(/timed out/);
  });
});
