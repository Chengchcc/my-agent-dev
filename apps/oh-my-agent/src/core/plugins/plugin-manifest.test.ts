import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMarketplace, installPlugin, loadPluginManifest } from "./plugin-marketplace.js";

function ws(): string {
  return mkdtempSync(join(tmpdir(), "oma-manifest-"));
}

describe("multi-source plugin manifest", () => {
  test("oma plugin.json wins and reads tools/hooks entries", () => {
    const root = ws();
    try {
      writeFileSync(
        join(root, "plugin.json"),
        JSON.stringify({ name: "mine", tools: "./tools.ts", hooks: "./hooks.ts" }),
      );
      mkdirSync(join(root, ".claude-plugin"));
      writeFileSync(
        join(root, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "claude-name", version: "9.9.9" }),
      );
      const m = loadPluginManifest(root);
      expect(m?.name).toBe("mine");
      expect(m?.toolsEntry).toBe("./tools.ts");
      expect(m?.hooksEntry).toBe("./hooks.ts");
      // Claude manifest fills only what oma manifest lacks
      expect(m?.version).toBe("9.9.9");
      expect(m?.warnings.join(" ")).toContain("dual manifest");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to .claude-plugin/plugin.json (skills carrier)", () => {
    const root = ws();
    try {
      mkdirSync(join(root, ".claude-plugin"));
      writeFileSync(
        join(root, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "claude-plugin", version: "1.0.0", skills: "./custom-skills" }),
      );
      const m = loadPluginManifest(root);
      expect(m?.name).toBe("claude-plugin");
      expect(m?.skills).toBe("./custom-skills");
      expect(m?.toolsEntry).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("omp package.json pi/omp code fields are ignored with warnings", () => {
    const root = ws();
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "omp-plugin",
          version: "2.0.0",
          omp: { tools: "./src/tools.ts", hooks: "./src/hooks.ts", features: {} },
        }),
      );
      const m = loadPluginManifest(root);
      expect(m?.name).toBe("omp-plugin");
      expect(m?.toolsEntry).toBeUndefined();
      expect(m?.warnings.join(" ")).toContain("omp");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("claude inline hooks and commands fields are ignored with warnings", () => {
    const root = ws();
    try {
      mkdirSync(join(root, ".claude-plugin"));
      writeFileSync(
        join(root, ".claude-plugin", "plugin.json"),
        JSON.stringify({
          name: "c",
          hooks: { PostToolUse: [] },
          commands: ["./cmd"],
          agents: ["./a.md"],
        }),
      );
      const m = loadPluginManifest(root);
      expect(m?.name).toBe("c");
      expect(m?.warnings.some((w) => w.includes("hooks"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no manifest anywhere returns null", () => {
    const root = ws();
    try {
      expect(loadPluginManifest(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
