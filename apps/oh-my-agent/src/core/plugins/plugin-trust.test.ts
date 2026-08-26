import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePluginHash, readTrustedPlugins, trustPlugin } from "./plugin-trust.js";

function setup(): { agent: string; pluginRoot: string } {
  const agent = mkdtempSync(join(tmpdir(), "oma-trust-agent-"));
  process.env.OMA_CODING_AGENT_DIR = agent;
  const pluginRoot = mkdtempSync(join(tmpdir(), "oma-trust-plugin-"));
  mkdirSync(join(pluginRoot, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(pluginRoot, "tools.ts"), "export const tools = [];");
  writeFileSync(join(pluginRoot, "node_modules", "dep", "x.js"), "x");
  return { agent, pluginRoot };
}

describe("plugin trust record", () => {
  test("hash covers files but skips node_modules; content change changes hash", () => {
    const { agent, pluginRoot } = setup();
    try {
      const h1 = computePluginHash(pluginRoot);
      expect(h1.startsWith("sha256:")).toBe(true);
      writeFileSync(join(pluginRoot, "node_modules", "dep", "y.js"), "y");
      expect(computePluginHash(pluginRoot)).toBe(h1);
      writeFileSync(join(pluginRoot, "extra.ts"), "x");
      expect(computePluginHash(pluginRoot)).not.toBe(h1);
    } finally {
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(agent, { recursive: true, force: true });
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  test("trustPlugin writes a record; readTrustedPlugins returns it; corrupt file = empty", () => {
    const { agent, pluginRoot } = setup();
    try {
      expect(readTrustedPlugins().get(pluginRoot)).toBeUndefined();
      trustPlugin(pluginRoot);
      const rec = readTrustedPlugins().get(pluginRoot);
      expect(rec?.hash).toBe(computePluginHash(pluginRoot));
      expect(typeof rec?.trustedAt).toBe("string");

      // corrupt file = treat all untrusted
      writeFileSync(join(agent, "trusted-plugins.json"), "not json {{{");
      expect(readTrustedPlugins().size).toBe(0);
    } finally {
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(agent, { recursive: true, force: true });
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });
});
