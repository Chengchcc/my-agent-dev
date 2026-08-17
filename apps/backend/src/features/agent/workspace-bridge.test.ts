import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knowledgePackIndex } from "../knowledge/install.js";
import {
  reconcileAgentResources,
  reconcileSkillLinks,
  writeMcpConfig,
} from "./workspace-bridge.js";

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
    writeMcpConfig(ws, [
      {
        name: "sse-srv",
        transport: "sse",
        url: "http://127.0.0.1:9/mcp",
        headers: { Authorization: "Bearer t" },
      },
      {
        name: "stdio-srv",
        transport: "stdio",
        command: "my-tool",
        args: ["--flag"],
        env: { ROOT: "/tmp" },
      },
    ]);
    const path = join(ws, ".mcp.json");
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcpServers["sse-srv"]).toEqual({
      type: "sse",
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer t" },
    });
    expect(parsed.mcpServers["stdio-srv"]).toEqual({
      type: "stdio",
      command: "my-tool",
      args: ["--flag"],
      env: { ROOT: "/tmp" },
    });

    writeMcpConfig(ws, []);
    expect(existsSync(path)).toBe(false);
    rmSync(ws, { recursive: true, force: true });
  });

  test("knowledgePackIndex excludes .git", () => {
    const ws = tmpWorkspace();
    const pack = join(ws, "pack");
    mkdirSync(join(pack, ".git"), { recursive: true });
    mkdirSync(join(pack, "docs"), { recursive: true });
    writeFileSync(join(pack, ".git", "HEAD"), "ref: refs/heads/main");
    writeFileSync(join(pack, "docs", "a.md"), "# A");
    const index = knowledgePackIndex({ name: "p", description: "d", installedRef: pack });
    expect(index).not.toContain(".git");
    expect(index).toContain("docs/");
    rmSync(ws, { recursive: true, force: true });
  });
});

describe("extraRoots bridge (ADR 0023)", () => {
  test("mcp + product tools bridge into worktree roots too", () => {
    const ws = tmpWorkspace();
    const wt = tmpWorkspace();
    reconcileAgentResources({
      workspacePath: ws,
      kind: "coding_agent",
      skillPacks: [],
      mcpServers: [
        {
          name: "product-tools",
          transport: "sse",
          url: "http://127.0.0.1:3005/sse",
          bearerTokenEnv: "PRODUCT_TOOLS_RUN_TOKEN",
        },
      ],
      productTools: [{ name: "history_recent" }],
      knowledgePacks: [],
      extraRoots: [wt],
    });
    expect(existsSync(join(wt, ".mcp.json"))).toBe(true);
    expect(existsSync(join(wt, ".agent", "product-tools.json"))).toBe(true);
  });
});
