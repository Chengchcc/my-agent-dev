import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileSkillLinks, writeMcpConfig } from "./workspace-bridge.js";

function tmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  return dir;
}

describe("workspace bridge", () => {
  test("reconcileSkillLinks creates links and removes stale ones (idempotent)", () => {
    const ws = tmpWorkspace();
    mkdirSync(join(ws, "packs", "p1"), { recursive: true });
    mkdirSync(join(ws, "packs", "p2"), { recursive: true });

    reconcileSkillLinks(ws, "omp", [
      { id: "p1", source: join(ws, "packs", "p1") },
      { id: "p2", source: join(ws, "packs", "p2") },
    ]);
    const skillsDir = join(ws, ".omp", "skills");
    expect(readdirSync(skillsDir).sort()).toEqual(["p1", "p2"]);
    expect(lstatSync(join(skillsDir, "p1")).isSymbolicLink()).toBe(true);

    // Second pass: p2 unassigned → link removed; p1 untouched.
    reconcileSkillLinks(ws, "omp", [{ id: "p1", source: join(ws, "packs", "p1") }]);
    expect(readdirSync(skillsDir)).toEqual(["p1"]);

    rmSync(ws, { recursive: true, force: true });
  });

  test("a user's own dir at a pack slot is never clobbered", () => {
    const ws = tmpWorkspace();
    const slot = join(ws, ".pi", "skills", "user-dir");
    mkdirSync(slot, { recursive: true });
    reconcileSkillLinks(ws, "pi", []);
    expect(existsSync(slot)).toBe(true);
    rmSync(ws, { recursive: true, force: true });
  });

  test("writeMcpConfig writes servers and removes the file when empty", () => {
    const ws = tmpWorkspace();
    writeMcpConfig(ws, "omp", [
      { name: "sse-srv", transport: "sse", url: "http://127.0.0.1:9/mcp" },
      { name: "stdio-srv", transport: "stdio", command: "my-tool" },
    ]);
    const path = join(ws, ".omp", "mcp.json");
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers: Record<string, Record<string, string>>;
    };
    expect(parsed.mcpServers["sse-srv"]).toEqual({
      type: "sse",
      url: "http://127.0.0.1:9/mcp",
    });
    expect(parsed.mcpServers["stdio-srv"]).toEqual({ type: "stdio", command: "my-tool" });

    writeMcpConfig(ws, "omp", []);
    expect(existsSync(path)).toBe(false);
    rmSync(ws, { recursive: true, force: true });
  });
});
