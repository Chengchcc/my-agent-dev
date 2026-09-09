import { describe, expect, test } from "bun:test";
import { createEvalTool } from "./eval.js";

const evalTool = createEvalTool({ workspaceRoot: process.cwd() });

describe("evalTool", () => {
  test("evaluates a snippet and returns the result", async () => {
    const result = await evalTool.execute({
      description: "sum",
      code: "export default async (ctx) => ({ sum: ctx.a + ctx.b })",
      input: { a: 1, b: 2 },
    });
    expect(result.content).toContain('"sum": 3');
    expect(result.isError).toBeFalsy();
  });

  test("timeout 0 lets a slow cell finish (no deadline)", async () => {
    const result = await evalTool.execute({
      description: "slow but allowed",
      code: "export default async () => { await Bun.sleep(300); return { ok: true }; }",
      timeout: 0,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('"ok": true');
  }, 15_000);

  test("jobAction=list with no jobs", async () => {
    const result = await evalTool.execute({ description: "d", jobAction: "list" });
    expect(result.content).toInclude("no background jobs");
  });

  test("async=true backgrounds a job; result pollable via jobAction", async () => {
    const started = await evalTool.execute({
      description: "bg",
      code: "export default async () => ({ done: true })",
      async: true,
    });
    expect(started.content).toMatch(/Backgrounded as job eval_\d+/);
    const jobId = /eval_\d+/.exec(started.content)?.[0] ?? "";

    let polled = "";
    for (let i = 0; i < 40 && !polled.includes('"done": true'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      polled = (await evalTool.execute({ description: "d", jobAction: "output", jobId })).content;
    }
    expect(polled).toContain("job");
    expect(polled).toContain('"done": true');
  }, 15_000);

  test("jobAction=kill aborts a running job", async () => {
    const started = await evalTool.execute({
      description: "bg-long",
      code: "export default async () => { await Bun.sleep(10_000); return {}; }",
      async: true,
      timeout: 0,
    });
    const jobId = /eval_\d+/.exec(started.content)?.[0] ?? "";
    const killed = await evalTool.execute({ description: "d", jobAction: "kill", jobId });
    expect(killed.content).toInclude("Killed");
    const output = await evalTool.execute({ description: "d", jobAction: "output", jobId });
    expect(output.content).toContain("killed");
  }, 15_000);

  test("unknown jobId errors", async () => {
    const result = await evalTool.execute({
      description: "d",
      jobAction: "output",
      jobId: "eval_999",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toInclude("unknown job");
  });
});
