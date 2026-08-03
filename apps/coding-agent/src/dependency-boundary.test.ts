import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(import.meta.dir, "..");

function allSourceFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
    }
  }
  walk(join(APP_DIR, "src"));
  return out;
}

describe("coding-agent dependency boundary", () => {
  const files = allSourceFiles();
  const sources = files.map((f) => readFileSync(f, "utf8")).join("\n");

  test("does not import apps/backend or Product features", () => {
    expect(sources).not.toMatch(/apps\/backend/);
    expect(sources).not.toMatch(/features\/(conversation|agent-context|agent-run)/);
    expect(sources).not.toMatch(/backend\.db|conversation_ledger/);
  });

  test("does not import old checkpointer or session modules", () => {
    expect(sources).not.toMatch(/checkpoint|runtimeSessionId|pendingContinuation/);
  });

  test("no in-process fallback factory", () => {
    expect(sources).not.toMatch(/in-process fallback|createAgent\(/);
  });
});
