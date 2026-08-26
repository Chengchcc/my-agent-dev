import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginCode } from "./plugin-code.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "oma-code-"));
}

describe("loadPluginCode", () => {
  test("loads a tools entry exporting PluginTool[] (named and default)", async () => {
    const root = tmp();
    try {
      writeFileSync(
        join(root, "tools.ts"),
        `
        export const tools = [{
          name: "hello", description: "says hello",
          async execute() { return { content: "hi" }; },
        }];
      `,
      );
      const r = await loadPluginCode(root, "./tools.ts");
      expect(r.ok).toBe(true);
      expect(r.tools?.map((t) => t.name)).toEqual(["hello"]);

      writeFileSync(
        join(root, "tools-default.ts"),
        `
        export default [{ name: "bye", description: "d",
          async execute() { return {}; } }];
      `,
      );
      const r2 = await loadPluginCode(root, "./tools-default.ts");
      expect(r2.tools?.[0]?.name).toBe("bye");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads a hooks entry exporting PluginHooks", async () => {
    const root = tmp();
    try {
      writeFileSync(
        join(root, "hooks.ts"),
        `
        export const hooks = { beforeRun() {}, afterTool() {} };
      `,
      );
      const r = await loadPluginCode(root, "./hooks.ts");
      expect(r.ok).toBe(true);
      expect(Object.keys(r.hooks ?? {})).toEqual(["beforeRun", "afterTool"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid exports fail soft with a reason, never throw", async () => {
    const root = tmp();
    try {
      writeFileSync(join(root, "bad.ts"), "export const tools = 42;");
      const r = await loadPluginCode(root, "./bad.ts");
      expect(r.ok).toBe(false);
      expect(r.error).toContain("tools");

      const missing = await loadPluginCode(root, "./nope.ts");
      expect(missing.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unknown hooks keys are dropped with a warning", async () => {
    const root = tmp();
    try {
      writeFileSync(
        join(root, "hooks2.ts"),
        `
        export const hooks = { beforeRun() {}, notAHook: 1 };
      `,
      );
      const r = await loadPluginCode(root, "./hooks2.ts");
      expect(r.ok).toBe(true);
      expect(r.hooks && "beforeRun" in r.hooks).toBe(true);
      expect(r.hooks && "notAHook" in r.hooks).toBe(false);
      expect(r.warnings.join(" ")).toContain("notAHook");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
