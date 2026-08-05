import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { ConfigError, loadConfig } from "./config.js";

const tmp = `/tmp/coding-agent-config-${Math.random().toString(36).slice(2, 8)}`;
mkdirSync(`${tmp}/ws`, { recursive: true });
// macOS canonicalizes /tmp -> /private/tmp via realpath; compare against the
// physical path, not the textual one.
const wsReal = realpathSync(`${tmp}/ws`);

const base = {
  CODING_AGENT_AUTH_TOKEN: "secret",
  CODING_AGENT_WORKSPACE_ROOTS: `${tmp}/ws`,
};

describe("daemon config", () => {
  test("defaults apply", () => {
    const cfg = loadConfig(base);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.workspaceRoots).toEqual([wsReal]);
    expect(cfg.eventBufferSize).toBe(1000);
  });

  test("empty token rejected", () => {
    expect(() => loadConfig({ ...base, CODING_AGENT_AUTH_TOKEN: "" })).toThrow(ConfigError);
  });

  test("malformed number rejected", () => {
    expect(() => loadConfig({ ...base, CODING_AGENT_PORT: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CODING_AGENT_PORT: "0" })).toThrow(ConfigError);
  });

  test("missing workspace roots rejected", () => {
    const bad = { ...base };
    delete bad.CODING_AGENT_WORKSPACE_ROOTS;
    expect(() => loadConfig(bad)).toThrow(ConfigError);
  });

  test("nonexistent workspace root rejected", () => {
    expect(() =>
      loadConfig({ ...base, CODING_AGENT_WORKSPACE_ROOTS: "/nonexistent-root-xyz" }),
    ).toThrow(ConfigError);
  });

  test("error names the field without printing secret", () => {
    try {
      loadConfig({ ...base, CODING_AGENT_AUTH_TOKEN: "" });
      expect.unreachable();
    } catch (err) {
      const e = err as ConfigError;
      expect(e.field).toBe("CODING_AGENT_AUTH_TOKEN");
      expect(e.message).not.toContain("secret");
    }
  });

  test("roots normalized to absolute realpath", () => {
    const cfg = loadConfig(base);
    expect(cfg.workspaceRoots[0]).toBe(wsReal);
  });
});
