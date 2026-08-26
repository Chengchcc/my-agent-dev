import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMarketplace, installPlugin, setPluginEnabled } from "./plugin-marketplace.js";
import { assemblePluginRuntime, resolvePluginComponents } from "./plugin-resolve.js";
import { trustPlugin } from "./plugin-trust.js";
import type { Plugin } from "../runtime/plugin.js";

function makePluginDir(marketRoot: string, name: string, withCode: boolean): string {
  const root = join(marketRoot, name);
  mkdirSync(join(root, "skills", name), { recursive: true });
  writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\nbody`);
  const manifest: Record<string, unknown> = { name, version: "1.0.0" };
  if (withCode) {
    manifest.tools = "./tools.ts";
    writeFileSync(
      join(root, "tools.ts"),
      `export const tools = [{ name: "${name}-tool", description: "d", async execute() { return {}; } }];`,
    );
  }
  writeFileSync(join(root, "plugin.json"), JSON.stringify(manifest));
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { [`${name}-srv`]: { command: "echo", args: ["hi"] } } }),
  );
  return root;
}

function setup(withCode = true): { workspace: string; agent: string; marketRoot: string } {
  const workspace = mkdtempSync(join(tmpdir(), "oma-res-ws-"));
  const agent = mkdtempSync(join(tmpdir(), "oma-res-agent-"));
  process.env.OMA_CODING_AGENT_DIR = agent;
  const marketRoot = join(workspace, "market");
  mkdirSync(marketRoot, { recursive: true });
  writeFileSync(
    join(marketRoot, "marketplace.json"),
    JSON.stringify({
      name: "mkt",
      plugins: [
        { name: "p-user", path: "p-user" },
        { name: "p-proj", path: "p-proj" },
      ],
    }),
  );
  makePluginDir(marketRoot, "p-user", withCode);
  makePluginDir(marketRoot, "p-proj", withCode);
  return { workspace, agent, marketRoot };
}

describe("resolvePluginComponents scope x mode matrix", () => {
  test("user-scope code loads in every mode; project-scope needs trust (tui) or is rejected (rpc)", () => {
    const { workspace, agent, marketRoot } = setup();
    try {
      expect(addMarketplace(workspace, marketRoot).ok).toBe(true);
      expect(installPlugin(workspace, "mkt/p-user", "user").ok).toBe(true);
      expect(installPlugin(workspace, "mkt/p-proj", "project").ok).toBe(true);

      // user: all modes approved (project untrusted blocks only itself)
      for (const mode of ["tui", "print", "json", "rpc"] as const) {
        const r = resolvePluginComponents(workspace, mode);
        expect(r.codeEntries.map((c) => c.name)).toEqual(["p-user"]);
      }

      // project untrusted: tui warns with the trust hint, rpc names its rule
      const tui = resolvePluginComponents(workspace, "tui");
      expect(tui.codeEntries.map((c) => c.name)).toEqual(["p-user"]);
      expect(tui.warnings.join(" ")).toContain("/plugin trust");
      const rpc = resolvePluginComponents(workspace, "rpc");
      expect(rpc.codeEntries.map((c) => c.name)).toEqual(["p-user"]);
      expect(rpc.warnings.join(" ")).toContain("rpc");

      // after trusting: tui/print/json approve; rpc STILL rejects project
      const projRoot = join(workspace, ".oma", "plugins", "p-proj");
      trustPlugin(projRoot);
      const tui2 = resolvePluginComponents(workspace, "tui");
      expect(tui2.codeEntries.map((c) => c.name).sort()).toEqual(["p-proj", "p-user"]);
      const rpc2 = resolvePluginComponents(workspace, "rpc");
      expect(rpc2.codeEntries.map((c) => c.name)).toEqual(["p-user"]);

      // mcp configs follow the same gates
      expect(tui2.mcpServers.map((m) => m.pluginName).sort()).toEqual(["p-proj", "p-user"]);
      expect(rpc2.mcpServers.map((m) => m.pluginName)).toEqual(["p-user"]);
    } finally {
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(agent, { recursive: true, force: true });
    }
  });

  test("disabled plugins contribute nothing; assemblePluginRuntime loads code into Plugin objects", async () => {
    const { workspace, agent, marketRoot } = setup();
    try {
      expect(addMarketplace(workspace, marketRoot).ok).toBe(true);
      expect(installPlugin(workspace, "mkt/p-user", "user").ok).toBe(true);
      setPluginEnabled(workspace, "p-user", false);
      expect(resolvePluginComponents(workspace, "tui").codeEntries).toEqual([]);

      setPluginEnabled(workspace, "p-user", true);
      const assembled = await assemblePluginRuntime(workspace, "tui");
      const plugin: Plugin | undefined = assembled.plugins.find((p) => p.name === "plugin:p-user");
      expect(plugin?.tools?.map((t) => t.name)).toEqual(["p-user-tool"]);
    } finally {
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(agent, { recursive: true, force: true });
    }
  });
});
