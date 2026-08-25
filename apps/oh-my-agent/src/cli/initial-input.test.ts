import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStandaloneSkillRoots } from "./initial-input.js";

describe("resolveStandaloneSkillRoots", () => {
  test("defaults to project .oma/skills and global agentDir/skills", () => {
    const ws = mkdtempSync(join(tmpdir(), "oma-skills-ws-"));
    const agent = mkdtempSync(join(tmpdir(), "oma-skills-agent-"));
    process.env.OMA_CODING_AGENT_DIR = agent;
    try {
      mkdirSync(join(ws, ".oma", "skills", "demo"), { recursive: true });
      mkdirSync(join(agent, "skills", "global-skill"), { recursive: true });
      const roots = resolveStandaloneSkillRoots(ws);
      expect(roots).toEqual([join(ws, ".oma", "skills"), join(agent, "skills")]);
    } finally {
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(ws, { recursive: true, force: true });
      rmSync(agent, { recursive: true, force: true });
    }
  });

  test("settings.skills overrides defaults and resolves relative paths", () => {
    const ws = mkdtempSync(join(tmpdir(), "oma-skills-cfg-"));
    const abs = mkdtempSync(join(tmpdir(), "oma-skills-abs-"));
    try {
      mkdirSync(join(ws, "custom-skills"), { recursive: true });
      mkdirSync(abs, { recursive: true });
      mkdirSync(join(ws, ".oma"), { recursive: true });
      writeFileSync(
        join(ws, ".oma", "settings.json"),
        JSON.stringify({ skills: ["custom-skills", abs] }),
        "utf8",
      );
      const roots = resolveStandaloneSkillRoots(ws);
      expect(roots).toEqual([join(ws, "custom-skills"), abs]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(abs, { recursive: true, force: true });
    }
  });

  test("enableClaude adds project .claude skills to defaults", () => {
    const ws = mkdtempSync(join(tmpdir(), "oma-skills-claude-"));
    const agent = mkdtempSync(join(tmpdir(), "oma-skills-claude-agent-"));
    process.env.OMA_CODING_AGENT_DIR = agent;
    try {
      mkdirSync(join(ws, ".oma", "skills"), { recursive: true });
      mkdirSync(join(ws, ".claude", "skills"), { recursive: true });
      mkdirSync(join(ws, ".oma"), { recursive: true });
      writeFileSync(
        join(ws, ".oma", "settings.json"),
        JSON.stringify({ enableClaude: true }),
        "utf8",
      );
      const roots = resolveStandaloneSkillRoots(ws);
      expect(roots).toContain(join(ws, ".oma", "skills"));
      expect(roots).toContain(join(ws, ".claude", "skills"));
    } finally {
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(ws, { recursive: true, force: true });
      rmSync(agent, { recursive: true, force: true });
    }
  });
});
