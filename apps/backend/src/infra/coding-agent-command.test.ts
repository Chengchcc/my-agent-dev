import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { BackendConfig } from "../config.js";
import { resolveCodingAgentCommand } from "./coding-agent-command.js";

const baseConfig: BackendConfig = {
  dataDir: "/tmp",
  workspaceRoot: "/tmp",
  templateDir: "/tmp/templates",
  anthropicApiKey: "sk-test",
  anthropicBaseUrl: "https://api.anthropic.com",
  host: "0.0.0.0",
  port: 3000,
  authToken: "test-token",
  cancelGraceMs: 100,
  maxConcurrentRuns: 4,
  shutdownTimeoutMs: 5000,
  reaperIntervalMs: 30000,
  stepStallTimeoutMs: 300000,
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

  test("secrets travel only via env, merged with caller env", () => {
    const result = resolveCodingAgentCommand(
      {
        ...baseConfig,
        anthropicApiKey: "sk-abc",
        anthropicBaseUrl: "https://proxy.example",
        productToolsServiceToken: "tok-secret",
      },
      { env: { EXTRA: "1" } },
    );

    expect(result.env).toMatchObject({
      ANTHROPIC_API_KEY: "sk-abc",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      CODING_AGENT_PRODUCT_TOOL_TOKEN: "tok-secret",
      EXTRA: "1",
    });
    // The token never appears in the command line.
    expect(JSON.stringify(result.args ?? [])).not.toContain("tok-secret");
  });

  test("omits absent secrets", () => {
    const result = resolveCodingAgentCommand({
      ...baseConfig,
      anthropicApiKey: undefined,
      productToolsServiceToken: undefined,
    } as unknown as BackendConfig);

    expect(result.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.env?.CODING_AGENT_PRODUCT_TOOL_TOKEN).toBeUndefined();
  });

  test("resolves to the real source entry from this file's location", () => {
    const expected = resolve(import.meta.dir, "../../../coding-agent/src/cli.ts");
    expect(existsSync(expected)).toBe(true);
  });
});
