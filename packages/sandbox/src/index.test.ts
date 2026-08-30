import { expect, test } from "bun:test";
import { runInSandbox } from "./index.js";

test("runs a script and returns its output", async () => {
  const r = await runInSandbox({
    code: `export default async (ctx) => ({ echo: ctx.msg, doubled: ctx.n * 2 });`,
    input: { msg: "hi", n: 21 },
    timeoutMs: 15_000,
  });
  expect(r.exitCode).toBe(0);
  expect(r.output).toEqual({ echo: "hi", doubled: 42 });
});

test("captures stdout and stderr", async () => {
  const r = await runInSandbox({
    code: `export default async () => { console.log("out-line"); console.error("err-line"); return { ok: true }; };`,
    input: {},
  });
  expect(r.stdout).toContain("out-line");
  expect(r.stderr).toContain("err-line");
  expect(r.output).toEqual({ ok: true });
});

test("script error surfaces on stderr with non-zero exit", async () => {
  const r = await runInSandbox({
    code: `export default async () => { throw new Error("boom"); };`,
    input: {},
  });
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr).toContain("boom");
  expect(r.output).toBeNull();
});

test("timeout kills the process", async () => {
  await expect(
    runInSandbox({
      code: `export default async () => { await new Promise(() => {}); };`,
      input: {},
      timeoutMs: 1_000,
    }),
  ).rejects.toThrow(/timed out/);
});

test("minimal env — no host env leakage by default", async () => {
  const r = await runInSandbox({
    code: `export default async () => ({ hasSecret: typeof process.env.SANDBOX_LEAK_TEST !== "undefined" });`,
    input: {},
    env: {},
  });
  expect(r.output).toEqual({ hasSecret: false });
});
