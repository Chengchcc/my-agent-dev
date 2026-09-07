import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BackendConfig } from "../../config.js";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteSettingsAdapter } from "./adapter-sqlite.js";
import { createSettingsService } from "./service.js";

const db = openDb(":memory:");
const port = sqliteSettingsAdapter(db);

const mockConfig = {
  dataDir: "/test-data",
  workspaceRoot: "/test-data/workspaces",
  builtinSkillsDir: "/test-skills",
} as BackendConfig;

const svc = createSettingsService({ port, config: mockConfig });

describe("SettingsService", () => {
  test("get missing key returns undefined", () => {
    expect(svc.get("does.not.exist")).toBeUndefined();
  });

  test("set + get number", () => {
    svc.set("num.key", 42);
    expect(svc.get<number>("num.key")).toBe(42);
  });

  test("set + get string", () => {
    svc.set("str.key", "hello");
    expect(svc.get<string>("str.key")).toBe("hello");
  });

  test("set + get boolean", () => {
    svc.set("bool.key", true);
    expect(svc.get<boolean>("bool.key")).toBe(true);
  });

  test("set + get object", () => {
    svc.set("obj.key", { nested: true });
    expect(svc.get<{ nested: boolean }>("obj.key")).toEqual({ nested: true });
  });

  test("overwrite existing key", () => {
    svc.set("ow.key", "A");
    expect(svc.get<string>("ow.key")).toBe("A");
    svc.set("ow.key", "B");
    expect(svc.get<string>("ow.key")).toBe("B");
  });

  test("getAll returns all keys", () => {
    svc.set("all.one", 1);
    svc.set("all.two", 2);
    svc.set("all.three", 3);
    const all = svc.getAll();
    expect(all["all.one"]).toBe(1);
    expect(all["all.two"]).toBe(2);
    expect(all["all.three"]).toBe(3);
  });

  test("getAll masks secret-shaped values (H5)", () => {
    svc.set("provider.anthropic", { apiKey: "sk-ant-secret-9z", baseUrl: "https://api.x" });
    svc.set("session.token", "tok-1234");
    const all = svc.getAll();
    const provider = all["provider.anthropic"] as { apiKey: string; baseUrl: string };
    expect(provider.apiKey).toMatch(/^\*{4}/);
    expect(provider.apiKey).not.toContain("sk-ant-secret-9z");
    expect(provider.baseUrl).toBe("https://api.x");
    expect(all["session.token"]).toMatch(/^\*{4}1234$/);
  });

  describe("getSystemInfo", () => {
    const KEY = "ANTHROPIC_API_KEY";
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env[KEY];
    });

    afterEach(() => {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    });

    test("returns masked env + paths", () => {
      process.env[KEY] = "sk-ant-1234567890abcdef";
      const info = svc.getSystemInfo();
      expect(info.paths.dataDir).toBe("/test-data");
      expect(info.paths.workspaceRoot).toBe("/test-data/workspaces");
      expect(info.paths.builtinSkills).toBe("/test-skills");
      // secret env key is masked: **** + last4 of the value
      expect(info.env[KEY]).toBe("****cdef");
    });

    test("omits unset env keys", () => {
      delete process.env[KEY];
      const info = svc.getSystemInfo();
      expect(info.env[KEY]).toBeUndefined();
    });
  });
});
