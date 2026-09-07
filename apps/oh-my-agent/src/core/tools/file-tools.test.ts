import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditTool, createWriteTool } from "./file-tools.js";

/** H1: product-managed config files are read-only for the agent — a tampered
 *  .mcp.json would mount arbitrary servers with zero approval. */
describe("write/edit protect product config files (H1)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-prot-"));

  test("write refuses .mcp.json", async () => {
    const res = await createWriteTool({ cwd }).execute({ path: ".mcp.json", content: "{}" });
    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(/product-managed/);
  });

  test("write refuses nested .oma/product-tools.json", async () => {
    const res = await createWriteTool({ cwd }).execute({
      path: ".oma/product-tools.json",
      content: "[]",
    });
    expect(res.isError).toBe(true);
  });

  test("edit refuses .claude/settings.json", async () => {
    const res = await createEditTool({ cwd }).execute({
      path: ".claude/settings.json",
      old_string: "a",
      new_string: "b",
    });
    expect(res.isError).toBe(true);
  });

  test("write still allows normal files", async () => {
    const res = await createWriteTool({ cwd }).execute({ path: "notes/a.md", content: "hi" });
    expect(res.isError).toBeUndefined();
  });
});
