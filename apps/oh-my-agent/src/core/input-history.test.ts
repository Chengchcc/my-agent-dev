import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInputHistory, loadInputHistory, saveInputHistory } from "./input-history.js";

describe("input history", () => {
  test("append is newest-first, skips consecutive duplicates, hoists older ones", () => {
    let h: readonly string[] = [];
    h = appendInputHistory(h, "first");
    h = appendInputHistory(h, "second");
    h = appendInputHistory(h, "second"); // consecutive duplicate: no-op
    h = appendInputHistory(h, "first"); // hoisted to the front
    expect(h).toEqual(["first", "second"]);
    // Blank/whitespace prompts are ignored entirely.
    expect(appendInputHistory(h, "   ")).toBe(h);
  });

  test("history caps at 500 entries", () => {
    let h: readonly string[] = [];
    for (let i = 0; i < 520; i++) h = appendInputHistory(h, `prompt ${i}`);
    expect(h).toHaveLength(500);
    expect(h[0]).toBe("prompt 519");
    expect(h.at(-1)).toBe("prompt 20");
  });

  test("load/save round-trip; missing file yields []", () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-hist-"));
    process.env.OMA_CODING_AGENT_DIR = dir;
    try {
      expect(loadInputHistory()).toEqual([]);
      saveInputHistory(["a", "b"]);
      expect(loadInputHistory()).toEqual(["a", "b"]);
      // Corrupt file degrades to [] instead of throwing.
      writeFileSync(join(dir, "history.json"), "{not json", "utf8");
      expect(loadInputHistory()).toEqual([]);
    } finally {
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
