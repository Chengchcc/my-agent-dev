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
  cancelGraceMs: number;
  /** Absolute path to the repo skills/ directory (source for builtin seed). */
  builtinSkillsDir: string;
  /** Coding Agent executable (spawned per Run). Defaults to "coding-agent"
   *  on PATH; tests point it at the Bun runtime + app entry source. */
  codingAgentBin?: string;
  productToolsMcpUrl?: string;
  productToolsServiceToken?: string;
}

/**
 * Load backend config from validated environment (single source: parseEnv).
 * Computed defaults (like dataDir relative to this file) are applied here.
 */
export function loadConfig(env: Env = parseEnv(process.env)): BackendConfig {
  const dataDir = env.BACKEND_DATA_DIR ?? `${import.meta.dir}/../.backend-data`;

  return {
    port: env.BACKEND_PORT,
    host: env.BACKEND_HOST,
    dataDir,
    workspaceRoot: env.BACKEND_WORKSPACE_ROOT ?? `${dataDir}/workspaces`,
    templateDir: env.BACKEND_TEMPLATE_DIR ?? `${dataDir}/templates`,
    authToken: env.BACKEND_AUTH_TOKEN,
    maxConcurrentRuns: env.BACKEND_MAX_CONCURRENT,
    cancelGraceMs: env.BACKEND_CANCEL_GRACE_MS,
    builtinSkillsDir: process.env.BUILTIN_SKILLS_DIR ?? resolve(import.meta.dir, "../../../skills"),
    codingAgentBin: env.CODING_AGENT_BIN,
    productToolsMcpUrl: env.PRODUCT_TOOLS_MCP_URL,
    productToolsServiceToken: env.PRODUCT_TOOLS_SERVICE_TOKEN,
  };
}
