import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PKG_DIR = join(import.meta.dir, "..");

function allSourceFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
    }
  }
  walk(join(PKG_DIR, "src"));
  return out;
}

describe("adapter-coding-agent dependency boundary", () => {
  const files = allSourceFiles();
  const sources = files.map((f) => readFileSync(f, "utf8")).join("\n");

  test("does not import @my-agent-team/agent or @my-agent-team/ai", () => {
    expect(sources).not.toMatch(/@my-agent-team\/(agent|ai)(?!-)/);
  });

  test("does not import Elysia, Drizzle, bun:sqlite, or apps", () => {
    expect(sources).not.toMatch(/elysia|drizzle|bun:sqlite|apps\//);
  });

  test("no in-process fallback", () => {
    expect(sources).not.toMatch(/in-process fallback|createAgent\(/);
  });
});
