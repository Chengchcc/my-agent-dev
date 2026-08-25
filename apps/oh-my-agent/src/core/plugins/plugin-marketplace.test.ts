import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMarketplace,
  enabledPluginSkillRoots,
  installPlugin,
  listInstalledPlugins,
  listMarketplaces,
  removeMarketplace,
  setPluginEnabled,
  uninstallPlugin,
} from "./plugin-marketplace.js";

function makeMarketplace(workspace: string): { marketRoot: string; agent: string } {
  const agent = mkdtempSync(join(tmpdir(), "oma-plug-agent-"));
  process.env.OMA_CODING_AGENT_DIR = agent;
  const marketRoot = join(workspace, "marketplace");
  mkdirSync(join(marketRoot, "demo-plugin", "skills", "demo"), { recursive: true });
  writeFileSync(
    join(marketRoot, "marketplace.json"),
    JSON.stringify({
      name: "demo-market",
      plugins: [{ name: "demo-plugin", path: "demo-plugin" }],
    }),
  );
  writeFileSync(
    join(marketRoot, "demo-plugin", "plugin.json"),
    JSON.stringify({ name: "demo-plugin", version: "1.0.0", description: "Demo" }),
  );
  writeFileSync(
    join(marketRoot, "demo-plugin", "skills", "demo", "SKILL.md"),
    "---\nname: demo\n---\nBody\n",
  );
  return { marketRoot, agent };
}

describe("plugin-marketplace", () => {
  test("add/list/install/uninstall marketplace and plugin", () => {
    const ws = mkdtempSync(join(tmpdir(), "oma-plug-ws-"));
    const { marketRoot, agent } = makeMarketplace(ws);
    try {
      const add = addMarketplace(ws, marketRoot);
      expect(add.ok).toBe(true);
      expect(listMarketplaces(ws).map((m) => m.name)).toEqual(["demo-market"]);

      const install = installPlugin(ws, "demo-market/demo-plugin");
      expect(install.ok).toBe(true);
      const plugins = listInstalledPlugins(ws);
      expect(plugins).toHaveLength(1);
      expect(plugins[0]?.name).toBe("demo-plugin");
      expect(plugins[0]?.enabled).toBe(true);
      expect(plugins[0]?.version).toBe("1.0.0");
      expect(plugins[0]?.skillsDir).toBeDefined();

      const skillRoots = enabledPluginSkillRoots(ws);
      expect(skillRoots).toEqual([expect.stringContaining("demo-plugin/skills")]);

      expect(setPluginEnabled(ws, "demo-plugin", false)).toBe(true);
      expect(enabledPluginSkillRoots(ws)).toEqual([]);

      expect(uninstallPlugin(ws, "demo-plugin")).toBe(true);
      expect(listInstalledPlugins(ws)).toEqual([]);

      expect(removeMarketplace(ws, "demo-market")).toBe(true);
      expect(listMarketplaces(ws)).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(agent, { recursive: true, force: true });
    }
  });
});
