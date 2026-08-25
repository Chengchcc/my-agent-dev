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
});
