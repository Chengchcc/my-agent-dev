import { describe, expect, test } from "bun:test";
import { createNodeRunners } from "./node-runners.js";

describe("createNodeRunners", () => {
  test("script node executes TS default export", async () => {
    const runners = createNodeRunners({ dataDir: ".backend-data/workflow-scripts" });
    const out = await runners.script.run(
      { id: "s", type: "script", code: "export default async (ctx) => ({ sent: ctx.input.x })" },
      {
        input: { x: 1 },
        store: { get: () => undefined, set: async () => {}, delete: async () => {} },
        context: { executionId: "e", nodeId: "s", workflowId: "wf" },
      },
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
        {
          input: {},
          store: { get: () => undefined, set: async () => {}, delete: async () => {} },
          context: { executionId: "e", nodeId: "s", workflowId: "wf" },
        },
      ),
    ).rejects.toThrow(/timed out/);
  });

  test("human node creates pendingAction via agentRunService and uses dynamic form", async () => {
    const created = { value: null as string | null };
    const runners = createNodeRunners({
      dataDir: ".data",
      agentRunService: {
        createPendingAction: async (
          _runId: string,
          action: { kind: string; payload: Record<string, unknown> },
        ) => {
          created.value = action.kind;
          return {
            actionId: "a",
            runId: "x",
            kind: action.kind,
            payload: action.payload,
            status: "pending",
          };
        },
      } as never,
    });
    const out = await runners.human.run(
      { id: "h", type: "human", question: "static?" },
      {
        input: { question: "dynamic?", form: { x: { type: "string" } } },
        store: { get: () => undefined, set: async () => {}, delete: async () => {} },
        context: { executionId: "e", nodeId: "h", workflowId: "wf" },
      },
    );
    expect(created.value).toBe("human_task_requested");
    expect((out.output as Record<string, unknown>).question).toBe("dynamic?");
  });
});
