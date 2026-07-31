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
});
