import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { BackendConfig } from "../config.js";
import { resolveCodingAgentCommand } from "./coding-agent-command.js";

const baseConfig: BackendConfig = {
  dataDir: "/tmp",
  workspaceRoot: "/tmp",
  templateDir: "/tmp/templates",
  host: "0.0.0.0",
  port: 3000,
  authToken: "test-token",
  cancelGraceMs: 100,
  maxConcurrentRuns: 4,
  builtinSkillsDir: "/tmp/skills",
};

describe("resolveCodingAgentCommand", () => {
  test("uses Bun + monorepo source CLI with --mode rpc when CODING_AGENT_BIN is absent", () => {
    const result = resolveCodingAgentCommand(baseConfig);

    expect(result.executable).toBe(process.execPath);
    expect(result.args).toEqual([
      expect.stringMatching(/\/apps\/coding-agent\/src\/cli\.ts$/),
      "--mode",
      "rpc",
    ]);
    expect(existsSync(result.args![0]!)).toBe(true);
  });

  test("uses explicit production executable with --mode rpc when CODING_AGENT_BIN is set", () => {
    const result = resolveCodingAgentCommand({
      ...baseConfig,
      codingAgentBin: "/app/bin/coding-agent",
    });

    expect(result.executable).toBe("/app/bin/coding-agent");
    // RPC mode is mandatory: without it the child blocks on piped stdin
    // (print mode) while the adapter keeps stdin open - a deadlock.
    expect(result.args).toEqual(["--mode", "rpc"]);
  });

  test("throws when the source fallback entry is missing", () => {
    expect(() =>
      resolveCodingAgentCommand(baseConfig, {
        appEntry: "/nonexistent/cli.ts",
      }),
    ).toThrow(/Coding Agent source entry not found/);
  });

  test("forwards provider env subset + token, merged with caller env", () => {
    const result = resolveCodingAgentCommand(
      {
        ...baseConfig,
        productToolsServiceToken: "tok-secret",
      },
      { env: { EXTRA: "1" } },
    );

    expect(result.env).toMatchObject({
      CODING_AGENT_PRODUCT_TOOL_TOKEN: "tok-secret",
      EXTRA: "1",
    });
    // Provider env keys are always present in the child env (forwarded from
    // process.env, possibly undefined — the child resolves which providers
    // have keys via its own catalog registration).
    expect("ANTHROPIC_API_KEY" in (result.env ?? {})).toBe(true);
    expect("DEEPSEEK_API_KEY" in (result.env ?? {})).toBe(true);
    expect("MY_AGENT_HOME" in (result.env ?? {})).toBe(true);
    // The token never appears in the command line.
    expect(JSON.stringify(result.args ?? [])).not.toContain("tok-secret");
  });

  test("omits absent product tools token", () => {
    const result = resolveCodingAgentCommand(baseConfig);
    expect(result.env?.CODING_AGENT_PRODUCT_TOOL_TOKEN).toBeUndefined();
  });

  test("resolves to the real source entry from this file's location", () => {
    const expected = resolve(import.meta.dir, "../../../coding-agent/src/cli.ts");
    expect(existsSync(expected)).toBe(true);
  });
});
