import { describe, expect, test } from "bun:test";
import { createGlobTool } from "./glob.js";

describe("globTool", () => {
  test("matches files by pattern", async () => {
    const tmpDir = `/tmp/test-glob-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}/sub`.quiet();
    await Bun.write(`${tmpDir}/a.ts`, "");
    await Bun.write(`${tmpDir}/b.ts`, "");
    await Bun.write(`${tmpDir}/c.txt`, "");

    const tool = createGlobTool({ workspaceRoot: tmpDir });
    const result = await tool.execute({ pattern: "*.ts" });

    expect(result.content).toInclude("a.ts");
    expect(result.content).toInclude("b.ts");
    expect(result.content).not.toInclude("c.txt");
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });

  test("returns (no matches) when nothing matches", async () => {
    const tmpDir = `/tmp/test-glob-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}`.quiet();

    const tool = createGlobTool({ workspaceRoot: tmpDir });
    const result = await tool.execute({ pattern: "*.xyz" });

    expect(result.content).toBe("(no matches)");
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });

  test("subdirectory cwd works within workspace", async () => {
    const tmpDir = `/tmp/test-glob-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}/sub`.quiet();
    await Bun.write(`${tmpDir}/sub/x.ts`, "");
    await Bun.write(`${tmpDir}/y.ts`, "");

    const tool = createGlobTool({ workspaceRoot: tmpDir });
    const result = await tool.execute({ pattern: "*.ts", cwd: "sub" });

    expect(result.content).toInclude("x.ts");
    expect(result.content).not.toInclude("y.ts");
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });

  test("out-of-bounds cwd returns tool error instead of root fallback", async () => {
    const tmpDir = `/tmp/test-glob-escape-${Date.now()}`;
    await Bun.$`mkdir -p ${tmpDir}`.quiet();
    const tool = createGlobTool({ workspaceRoot: tmpDir });
    const result = await tool.execute({ pattern: "**/*", cwd: "/etc" });
    expect(result.isError).toBe(true);
    expect(result.content).toInclude("escapes workspace");
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });
});
