import { beforeAll, describe, expect, test } from "bun:test";
import { createGrepTool } from "./grep.js";

const hasRg = (() => {
  try {
    Bun.spawnSync({ cmd: ["rg", "--version"], stdout: "ignore", stderr: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("grepTool", () => {
  beforeAll(() => {
    if (!hasRg) {
      console.warn("SKIP: rg (ripgrep) not installed — skipping grepTool tests");
    }
  });

  test("returns stdout when matches found", async () => {
    if (!hasRg) return;
    const tmpDir = `/tmp/test-grep-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}`.quiet();
    await Bun.write(`${tmpDir}/a.txt`, "hello world\nhello again\n goodbye");

    const tool = createGrepTool({ workspaceRoot: tmpDir });
    const result = await tool.execute({ pattern: "hello" });

    expect(result.content).toInclude("hello");
    expect(result.isError).toBeUndefined();
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });

  test("returns empty string on no matches (rg exit code 1)", async () => {
    if (!hasRg) return;
    const tmpDir = `/tmp/test-grep-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}`.quiet();
    await Bun.write(`${tmpDir}/a.txt`, "hello world");

    const tool = createGrepTool({ workspaceRoot: tmpDir });
    const result = await tool.execute({ pattern: "nonexistentZZZZ" });

    expect(result.content).toBe("");
    expect(result.isError).toBeUndefined();
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });

  test("glob filtering works", async () => {
    if (!hasRg) return;
    const tmpDir = `/tmp/test-grep-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}`.quiet();
    await Bun.write(`${tmpDir}/a.ts`, "hello");
    await Bun.write(`${tmpDir}/b.txt`, "hello");

    const tool = createGrepTool({ workspaceRoot: tmpDir });
    const result = await tool.execute({ pattern: "hello", glob: "*.ts" });

    expect(result.content).toInclude("a.ts");
    expect(result.content).not.toInclude("b.txt");
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });
});
