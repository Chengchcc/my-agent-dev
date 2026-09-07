import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { BackendConfig } from "../config.js";
import { resolveOmaCommand } from "./oma-command.js";

const baseConfig: BackendConfig = {
  dataDir: "/tmp",
  workspaceRoot: "/tmp",
  templateDir: "/tmp/templates",
  host: "0.0.0.0",
  port: 3000,
  authToken: "test-token",
  cancelGraceMs: 100,
  runTimeoutMs: 30 * 60_000,
  maxConcurrentRuns: 4,
  builtinSkillsDir: "/tmp/skills",
  workflowScriptsEnabled: false,
  workflowScriptDenyReadDirs: ["/tmp"],
};

describe("resolveOmaCommand", () => {
  test("uses Bun + monorepo source CLI with --mode rpc when OMA_BIN is absent", () => {
    const result = resolveOmaCommand(baseConfig);

    expect(result.executable).toBe(process.execPath);
    expect(result.args).toEqual([
      expect.stringMatching(/\/apps\/oh-my-agent\/src\/cli\.ts$/),
      "--mode",
      "rpc",
    ]);
    expect(existsSync(result.args![0]!)).toBe(true);
  });

  test("uses explicit production executable with --mode rpc when OMA_BIN is set", () => {
    const result = resolveOmaCommand({
      ...baseConfig,
      omaBin: "/app/bin/oma",
    });

    expect(result.executable).toBe("/app/bin/oma");
    // RPC mode is mandatory: without it the child blocks on piped stdin
    // (print mode) while the adapter keeps stdin open - a deadlock.
    expect(result.args).toEqual(["--mode", "rpc"]);
  });

  test("throws when the source fallback entry is missing", () => {
    expect(() =>
      resolveOmaCommand(baseConfig, {
        appEntry: "/nonexistent/cli.ts",
      }),
    ).toThrow(/Oma source entry not found/);
  });

  test("forwards provider env subset, merged with caller env", () => {
    const result = resolveOmaCommand(baseConfig, { env: { EXTRA: "1" } });

    expect(result.env).toMatchObject({ EXTRA: "1" });
    // Provider env keys are always present in the child env (forwarded from
    // process.env, possibly undefined — the child resolves which providers
    // have keys via its own catalog registration).
    expect("ANTHROPIC_API_KEY" in (result.env ?? {})).toBe(true);
    expect("DEEPSEEK_API_KEY" in (result.env ?? {})).toBe(true);
    expect("OMA_HOME" in (result.env ?? {})).toBe(true);
  });

  test("no product-tools token at the command layer — it is per-run", () => {
    // The bearer is minted per run at dispatch and injected by the backend
    // at execute time; resolveOmaCommand must never bake one in.
    const result = resolveOmaCommand(baseConfig);
    expect(result.env?.OMA_PRODUCT_TOOL_TOKEN).toBeUndefined();
  });

  test("resolves to the real source entry from this file's location", () => {
    const expected = resolve(import.meta.dir, "../../../oh-my-agent/src/cli.ts");
    expect(existsSync(expected)).toBe(true);
  });
});
