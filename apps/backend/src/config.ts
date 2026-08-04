import { resolve } from "node:path";
import type { Env } from "@my-agent-team/config";
import { parseEnv } from "@my-agent-team/config";

export interface BackendConfig {
  port: number;
  host: string;
  dataDir: string;
  workspaceRoot: string;
  templateDir: string;
  authToken: string;
  maxConcurrentRuns: number;
  anthropicApiKey: string;
  anthropicBaseUrl?: string;
  shutdownTimeoutMs: number;
  cancelGraceMs: number;
  reaperIntervalMs: number;
  stepStallTimeoutMs: number;
  /** Absolute path to the repo skills/ directory (source for builtin seed). */
  builtinSkillsDir: string;
  /** Phase 4: Coding Agent daemon + Product Tools MCP service endpoints. */
  codingAgentUrl?: string;
  codingAgentServiceToken?: string;
  productToolsMcpUrl?: string;
  productToolsServiceToken?: string;
}

/**
 * Load backend config from validated environment (single source: parseEnv).
 * Computed defaults (like dataDir relative to this file) are applied here.
 */
export function loadConfig(env: Env = parseEnv(process.env)): BackendConfig {
  const dataDir = env.BACKEND_DATA_DIR ?? `${import.meta.dir}/../.backend-data`;

  const anthropicApiKey = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
  if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is required");

  return {
    port: env.BACKEND_PORT,
    host: env.BACKEND_HOST,
    dataDir,
    workspaceRoot: env.BACKEND_WORKSPACE_ROOT ?? `${dataDir}/workspaces`,
    templateDir: env.BACKEND_TEMPLATE_DIR ?? `${dataDir}/templates`,
    authToken: env.BACKEND_AUTH_TOKEN,
    maxConcurrentRuns: env.BACKEND_MAX_CONCURRENT,
    anthropicApiKey,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL,
    shutdownTimeoutMs: env.BACKEND_SHUTDOWN_TIMEOUT_MS,
    cancelGraceMs: env.BACKEND_CANCEL_GRACE_MS,
    reaperIntervalMs: env.BACKEND_REAPER_INTERVAL_MS,
    stepStallTimeoutMs: env.BACKEND_STEP_STALL_TIMEOUT_MS,
    builtinSkillsDir: process.env.BUILTIN_SKILLS_DIR ?? resolve(import.meta.dir, "../../skills"),
    codingAgentUrl: env.CODING_AGENT_URL,
    codingAgentServiceToken: env.CODING_AGENT_SERVICE_TOKEN,
    productToolsMcpUrl: env.PRODUCT_TOOLS_MCP_URL,
    productToolsServiceToken: env.PRODUCT_TOOLS_SERVICE_TOKEN,
  };
}
