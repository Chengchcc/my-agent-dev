import { describe, expect, test } from "bun:test";
import { createNodeRunners } from "./node-runners.js";

const store = { get: () => undefined, set: async () => {}, delete: async () => {} };

describe("createNodeRunners", () => {
  test("script nodes are opt-in: disabled runner rejects the node (H2)", async () => {
    const runners = createNodeRunners({
      dataDir: ".backend-data/workflow-scripts",
      scriptsEnabled: false,
    });
    await expect(
      runners.script.run(
        { id: "s", type: "script", code: "export default async () => ({})" },
        { input: {}, store, context: { executionId: "e", nodeId: "s", workflowId: "wf" } },
      ),
    ).rejects.toThrow(/WORKFLOW_SCRIPTS_ENABLED/);
  });

  test("script node executes TS default export under sandbox isolation", async () => {
    const runners = createNodeRunners({
      dataDir: ".backend-data/workflow-scripts",
      scriptsEnabled: true,
      denyReadDirs: [".backend-data"],
    });
    const out = await runners.script.run(
      { id: "s", type: "script", code: "export default async (ctx) => ({ sent: ctx.x })" },
      { input: { x: 1 }, store, context: { executionId: "e", nodeId: "s", workflowId: "wf" } },
    );
    expect(out.output).toEqual({ sent: 1 });
  }, 30_000);

  test("script node times out", async () => {
    const runners = createNodeRunners({
      dataDir: ".backend-data/workflow-scripts",
      scriptsEnabled: true,
    });
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
  }, 30_000);
});
