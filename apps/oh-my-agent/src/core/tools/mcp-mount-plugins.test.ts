import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginMcpConfig } from "../plugins/plugin-resolve.js";
import { mergeMcpConfigs, substitutePluginVars } from "./mcp-mount.js";

describe("plugin mcp merge", () => {
  test("workspace wins on name conflicts; plugin order preserved otherwise", () => {
    const ws = mkdtempSync(join(tmpdir(), "oma-mcp-ws-"));
    try {
      writeFileSync(
        join(ws, ".mcp.json"),
        JSON.stringify({
          mcpServers: { shared: { command: "workspace-bin" }, wsOnly: { command: "a" } },
        }),
      );
      const plugins: PluginMcpConfig[] = [
        {
          pluginName: "p1",
          pluginRoot: "/x/p1",
          scope: "user",
          servers: { shared: { command: "plugin-bin" }, p1Only: { command: "b" } },
        },
        {
          pluginName: "p2",
          pluginRoot: "/x/p2",
          scope: "project",
          servers: { p2Only: { command: "c" } },
        },
      ];
      const merged = mergeMcpConfigs(ws, plugins);
      expect(Object.keys(merged).sort()).toEqual(["p1Only", "p2Only", "shared", "wsOnly"]);
      expect((merged.shared as { command: string }).command).toBe("workspace-bin");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("CLAUDE_PLUGIN_ROOT and CLAUDE_PROJECT_DIR substitute into command/args/env", () => {
    const out = substitutePluginVars(
      {
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/s.js"],
        env: { D: "${CLAUDE_PROJECT_DIR}" },
      },
      { pluginRoot: "/x/p1", workspaceRoot: "/w" },
    ) as { command: string; args: string[]; env: Record<string, string> };
    expect(out.args[0]).toBe("/x/p1/s.js");
    expect(out.env.D).toBe("/w");
    expect(out.env.CLAUDE_PLUGIN_ROOT).toBe("/x/p1");
    expect(out.env.CLAUDE_PROJECT_DIR).toBe("/w");
  });
});
