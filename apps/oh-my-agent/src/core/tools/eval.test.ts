import { describe, expect, test } from "bun:test";
import { createEvalTool } from "./eval.js";

const tool = createEvalTool({ workspaceRoot: process.cwd() });

describe("eval tool", () => {
  test("runs a snippet and returns its output", async () => {
    const r = (await tool.execute({
      description: "double a number",
      code: "export default async (ctx) => ({ doubled: ctx.n * 2 })",
      input: { n: 21 },
    })) as { content: string; isError?: boolean };
    expect(r.isError).toBe(false);
    expect(r.content).toContain('"doubled": 42');
  });

  test("reports stderr on script error", async () => {
    const r = (await tool.execute({
      description: "boom",
      code: "export default async () => { throw new Error('boom'); }",
    })) as { content: string; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content).toContain("boom");
  });

  test("rejects empty code", async () => {
    const r = (await tool.execute({ description: "empty", code: "  " })) as {
      isError?: boolean;
    };
    expect(r.isError).toBe(true);
  });
});
