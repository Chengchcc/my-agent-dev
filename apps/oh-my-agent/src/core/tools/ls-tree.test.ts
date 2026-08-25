import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLsTool, createTreeTool } from "./ls-tree.js";

const tmpRoot = `/tmp/ls-tree-test-${Math.random().toString(36).slice(2, 8)}`;

function setup(): void {
  mkdirSync(join(tmpRoot, "sub"), { recursive: true });
  writeFileSync(join(tmpRoot, "a.txt"), "a");
  writeFileSync(join(tmpRoot, "sub", "b.txt"), "b");
}

describe("ls/tree tools", () => {
  test("ls lists contained directory", async () => {
    setup();
    const tool = createLsTool({ cwd: tmpRoot });
    const result = await tool.execute({ path: "sub" });
    expect(result.content).toInclude("b.txt");
    expect(result.isError).toBeFalsy();
  });

  test("ls rejects out-of-bounds path", async () => {
    setup();
    const tool = createLsTool({ cwd: tmpRoot });
    const result = await tool.execute({ path: "/etc" });
    expect(result.isError).toBe(true);
    expect(result.content).toInclude("escapes workspace");
  });

  test("tree rejects out-of-bounds path", async () => {
    setup();
    const tool = createTreeTool({ cwd: tmpRoot });
    const result = await tool.execute({ path: "../../.." });
    expect(result.isError).toBe(true);
    expect(result.content).toInclude("escapes workspace");
  });
});
