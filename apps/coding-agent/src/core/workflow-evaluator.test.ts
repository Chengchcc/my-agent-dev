import { describe, expect, test } from "bun:test";
import { evaluateWorkflowScript } from "./workflow-evaluator.js";

const primitives = {
  agent: async (prompt: string) => ({
    text: `echo:${prompt}`,
    output: undefined,
    ok: true,
    label: "",
  }),
  pipeline: async (items: readonly unknown[], fn: (item: unknown) => Promise<unknown>) =>
    Promise.all(items.map(fn)),
};

describe("evaluateWorkflowScript", () => {
  test("runs top-level await scripts with agent + pipeline", async () => {
    const result = await evaluateWorkflowScript({
      script:
        'const found = await agent("find"); const all = await pipeline([1, 2], (x) => agent(String(x))); return all.length;',
      args: undefined,
      primitives: primitives as never,
    });
    expect(result.value).toBe(2);
  });

  test("args are passed as a global", async () => {
    const result = await evaluateWorkflowScript({
      script: "return args.count * 2;",
      args: { count: 21 },
      primitives: primitives as never,
    });
    expect(result.value).toBe(42);
  });

  test("fs/process/require are absent inside the sandbox", async () => {
    // typeof never throws for undeclared names: the value proves absence.
    const processType = await evaluateWorkflowScript({
      script: "return typeof process;",
      args: undefined,
      primitives: primitives as never,
    });
    expect(processType.value).toBe("undefined");
    const requireType = await evaluateWorkflowScript({
      script: "return typeof require;",
      args: undefined,
      primitives: primitives as never,
    });
    expect(requireType.value).toBe("undefined");
    // Direct access throws.
    await expect(
      evaluateWorkflowScript({
        script: "return process;",
        args: undefined,
        primitives: primitives as never,
      }),
    ).rejects.toThrow(/process is not defined/);
  });

  test("the timeout aborts a synchronous infinite loop", async () => {
    await expect(
      evaluateWorkflowScript({
        script: "while (true) {}",
        args: undefined,
        primitives: primitives as never,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out|Script execution timed out/);
  });

  test("the timeout races an async stall", async () => {
    await expect(
      evaluateWorkflowScript({
        script: "await new Promise(() => {});",
        args: undefined,
        primitives: primitives as never,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/);
  });
});
