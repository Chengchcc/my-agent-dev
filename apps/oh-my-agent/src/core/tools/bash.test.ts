import { describe, expect, test } from "bun:test";
import { createBashTool } from "./bash.js";

const bashTool = createBashTool({ workspaceRoot: process.cwd() });

describe("bashTool", () => {
  test("exit code 0 returns stdout", async () => {
    const result = await bashTool.execute({
      command: "echo hello && echo world >&2",
    });
    expect(result.content).toInclude("hello");
    expect(result.content).toInclude("world");
    expect(result.isError).toBeFalsy();
  });

  test("non-zero exit code returns isError", async () => {
    const result = await bashTool.execute({ command: "exit 1" });
    expect(result.isError).toBe(true);
  });

  test("timeout kills process", async () => {
    const result = await bashTool.execute({ command: "sleep 10", timeout: 100 });
    expect(result.isError).toBe(true);
  });

  test("default timeout is 30s (not enforced in fast test)", async () => {
    const result = await bashTool.execute({ command: "true" });
    expect(result.content).toInclude("exit: 0");
  });

  test("captures stdout and stderr", async () => {
    const result = await bashTool.execute({
      command: "echo stdout-text && echo stderr-text >&2",
    });
    expect(result.content).toInclude("stdout-text");
    expect(result.content).toInclude("stderr-text");
  });

  test("out-of-bounds cwd returns tool error, does not run in process cwd", async () => {
    const tmpDir = `/tmp/test-bash-escape-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}`.quiet();
    const tool = createBashTool({ workspaceRoot: tmpDir });
    const result = await tool.execute({ command: "pwd", cwd: "/etc" });
    expect(result.isError).toBe(true);
    expect(result.content).toInclude("escapes workspace");
    expect(result.content).not.toInclude(process.cwd());
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });

  test("AbortSignal kills a long-running command", async () => {
    const tmpDir = `/tmp/test-bash-abort-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}`.quiet();
    const tool = createBashTool({ workspaceRoot: tmpDir });
    const controller = new AbortController();
    const started = tool.execute({ command: "sleep 5", timeout: 10_000 }, controller.signal);
    // Abort shortly after the command starts
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
    controller.abort();
    const result = await started;
    // The command should have been killed (non-zero exit or error)
    expect(result.isError).toBe(true);
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });

  test("jobAction=list with no jobs", async () => {
    const result = await bashTool.execute({ command: "", jobAction: "list" });
    expect(result.content).toInclude("no background jobs");
  });

  test("async=true backgrounds a job; output pollable via jobAction", async () => {
    const started = await bashTool.execute({
      command: "echo bg-hello && sleep 5",
      async: true,
      timeout: 20_000,
    });
    expect(started.content).toMatch(/Backgrounded as job bg_\d+/);
    const jobId = /bg_\d+/.exec(started.content)?.[0] ?? "";
    expect(started.content).not.toInclude("bg-hello");

    // Eventually the output tail captures the echo.
    let polled = "";
    for (let i = 0; i < 40 && !polled.includes("bg-hello"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      polled = (await bashTool.execute({ command: "", jobAction: "output", jobId })).content;
    }
    expect(polled).toContain("bg-hello");

    // Kill it before sleep finishes.
    const killed = await bashTool.execute({ command: "", jobAction: "kill", jobId });
    expect(killed.content).toInclude("Killed");
  }, 20_000);

  test("background job timeout kills the job (M-bash)", async () => {
    const started = await bashTool.execute({
      command: "sleep 30",
      async: true,
      timeout: 300,
    });
    const jobId = /bg_\d+/.exec(started.content)?.[0] ?? "";
    let summary = "";
    for (let i = 0; i < 60 && !summary.includes("completed"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      summary = (await bashTool.execute({ command: "", jobAction: "output", jobId })).content;
    }
    expect(summary).toContain("timed out");
  }, 15_000);

  test("unknown jobId errors", async () => {
    const result = await bashTool.execute({ command: "", jobAction: "output", jobId: "bg_999" });
    expect(result.isError).toBe(true);
    expect(result.content).toInclude("unknown job");
  });

  test("pty=true allocates a real TTY (M-bash)", async () => {
    if (Bun.which("script") === null) return;
    const withPty = await bashTool.execute({
      command: "test -t 0 && echo IS_TTY || echo NO_TTY",
      pty: true,
    });
    expect(withPty.content).toContain("IS_TTY");
    // Control: the default pipe path is NOT a TTY.
    const withoutPty = await bashTool.execute({
      command: "test -t 0 && echo IS_TTY || echo NO_TTY",
    });
    expect(withoutPty.content).toContain("NO_TTY");
  }, 20_000);
});
