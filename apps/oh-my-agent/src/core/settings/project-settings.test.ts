import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasProjectSettings, loadProjectSettings, saveProjectModel } from "./project-settings.js";

describe("project settings", () => {
  test("missing/corrupt file degrades to {}", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-ps-"));
    try {
      expect(loadProjectSettings(root)).toEqual({});
      mkdirSync(join(root, ".oma"), { recursive: true });
      writeFileSync(join(root, ".oma", "settings.json"), "{not json", "utf8");
      expect(loadProjectSettings(root)).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("saveProjectModel writes and loadProjectSettings reads it", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-ps-"));
    try {
      expect(hasProjectSettings(root)).toBe(false);
      saveProjectModel(root, "fake/echo2");
      expect(hasProjectSettings(root)).toBe(true);
      expect(loadProjectSettings(root)).toEqual({ model: "fake/echo2" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads configured skills array", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-ps-"));
    try {
      mkdirSync(join(root, ".oma"), { recursive: true });
      writeFileSync(
        join(root, ".oma", "settings.json"),
        JSON.stringify({ model: "fake/echo", skills: ["skills", "/abs/skills"] }),
        "utf8",
      );
      expect(loadProjectSettings(root)).toEqual({
        model: "fake/echo",
        skills: ["skills", "/abs/skills"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads skill source toggles", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-ps-"));
    try {
      mkdirSync(join(root, ".oma"), { recursive: true });
      writeFileSync(
        join(root, ".oma", "settings.json"),
        JSON.stringify({ enableClaude: true, enableCodex: false, enableAgents: true }),
        "utf8",
      );
      expect(loadProjectSettings(root)).toEqual({
        enableClaude: true,
        enableCodex: false,
        enableAgents: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads P0 numeric/boolean knobs", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-ps-"));
    try {
      mkdirSync(join(root, ".oma"), { recursive: true });
      writeFileSync(
        join(root, ".oma", "settings.json"),
        JSON.stringify({
          maxSteps: 42,
          modelTimeoutMs: 1000,
          mcpTimeoutMs: 2000,
          disableWeb: true,
          bashSandbox: true,
          bashTimeoutMs: 5000,
          maxToolTimeoutMs: 600000,
          titleEnabled: false,
          memoryExtract: true,
          memoryModel: "fake/echo",
          permissionClassifierModel: "fake/echo2",
        }),
        "utf8",
      );
      expect(loadProjectSettings(root)).toEqual({
        maxSteps: 42,
        modelTimeoutMs: 1000,
        mcpTimeoutMs: 2000,
        disableWeb: true,
        bashSandbox: true,
        bashTimeoutMs: 5000,
        maxToolTimeoutMs: 600000,
        titleEnabled: false,
        memoryExtract: true,
        memoryModel: "fake/echo",
        permissionClassifierModel: "fake/echo2",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
