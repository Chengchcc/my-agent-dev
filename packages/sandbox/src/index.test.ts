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

test("timeout throws even when a detached grandchild holds stdout (H3)", async () => {
  // `setsid sleep` escapes the process group and inherits our stdout pipe:
  // EOF never arrives after the tree kill, so the old EOF-gated
  // Promise.all hung until the daemon exited. Completion is now gated on
  // proc.exited with a bounded post-exit drain.
  const start = Date.now();
  await expect(
    runInSandbox({
      // Explicit inherit: the daemon's stdout IS the sandbox's pipe (a
      // default-stdio spawn gets its own pipe and holds nothing).
      code: `export default async () => {
  const daemon = Bun.spawn(["setsid", "sleep", "5"], { stdout: "inherit", stderr: "inherit" });
  await daemon.exited;
  return { ok: true };
};`,
      input: {},
      timeoutMs: 1_500,
    }),
  ).rejects.toThrow(/timed out/);
  expect(Date.now() - start).toBeLessThan(5_000);
});

test("minimal env — no host env leakage by default", async () => {
  const r = await runInSandbox({
    code: `export default async () => ({ hasSecret: typeof process.env.SANDBOX_LEAK_TEST !== "undefined" });`,
    input: {},
    env: {},
  });
  expect(r.output).toEqual({ hasSecret: false });
});
