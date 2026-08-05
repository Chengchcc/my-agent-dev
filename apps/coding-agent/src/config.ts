import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Daemon configuration. Dedicated CODING_AGENT_* variables only; the daemon
 *  is an isolated single-tenant trust boundary with no Product coupling. */
export interface CodingAgentConfig {
  host: string;
  port: number;
  authToken: string;
  workspaceRoots: readonly string[];
  /** Provider credentials used by the in-process Run loops (minimal surface:
   *  only known provider env, never the whole process env). */
  providerEnv: Readonly<Record<string, string>>;
  eventBufferSize: number;
}

export class ConfigError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.field = field;
  }
}

function intField(name: string, raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new ConfigError(name, `${name} must be a number >= ${min}`);
  }
  return Math.floor(value);
}

function absoluteDir(raw: string, field: string): string {
  const abs = resolve(raw);
  if (!existsSync(abs)) {
    throw new ConfigError(field, `${field} does not exist: ${abs}`);
  }
  return realpathSync(abs);
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): CodingAgentConfig {
  const host = env.CODING_AGENT_HOST ?? "127.0.0.1";
  const port = intField("CODING_AGENT_PORT", env.CODING_AGENT_PORT, 4317, 1);
  const authToken = env.CODING_AGENT_AUTH_TOKEN ?? "";
  if (!authToken) {
    throw new ConfigError("CODING_AGENT_AUTH_TOKEN", "CODING_AGENT_AUTH_TOKEN must be non-empty");
  }

  const rootsRaw = env.CODING_AGENT_WORKSPACE_ROOTS;
  if (!rootsRaw) {
    throw new ConfigError(
      "CODING_AGENT_WORKSPACE_ROOTS",
      "CODING_AGENT_WORKSPACE_ROOTS is required",
    );
  }
  const workspaceRoots = rootsRaw
    .split(":")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => absoluteDir(r, "CODING_AGENT_WORKSPACE_ROOTS"));
  if (workspaceRoots.length === 0) {
    throw new ConfigError(
      "CODING_AGENT_WORKSPACE_ROOTS",
      "CODING_AGENT_WORKSPACE_ROOTS must contain at least one path",
    );
  }

  // Forward only known provider credentials to the in-process Run loops
  // (minimal env surface).
  const providerEnv: Record<string, string> = {};
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CODING_AGENT_FAKE_PROVIDER",
    // fake-provider tool script (deterministic integration tests)
    "CODING_AGENT_FAKE_TOOL",
    // service token for remote Product Tools MCP endpoints (the run runtime
    // attaches it to the SSE transport; never part of entrypoints or arguments)
    "CODING_AGENT_PRODUCT_TOOL_TOKEN",
  ]) {
    const v = env[key];
    if (v) providerEnv[key] = v;
  }

  return {
    host,
    port,
    authToken,
    workspaceRoots,
    providerEnv,
    eventBufferSize: intField(
      "CODING_AGENT_EVENT_BUFFER_SIZE",
      env.CODING_AGENT_EVENT_BUFFER_SIZE,
      1000,
      1,
    ),
  };
}
