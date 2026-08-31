import { resolve } from "node:path";
import type { Env } from "@chengchenccc/config";
import { parseEnv } from "@chengchenccc/config";

export interface BackendConfig {
  port: number;
  host: string;
  dataDir: string;
  workspaceRoot: string;
  templateDir: string;
  authToken: string;
  maxConcurrentRuns: number;
  cancelGraceMs: number;
  /** Wall-clock cap on a run: the dispatch watchdog stops the backend and
   *  settles the run aborted when it exceeds this. */
  runTimeoutMs: number;
  /** Absolute path to the repo skills/ directory (source for builtin seed). */
  builtinSkillsDir: string;
  /** Oma executable (spawned per Run). Defaults to "oma"
   *  on PATH; tests point it at the Bun runtime + app entry source. */
  omaBin?: string;
  /** Knowledge recall MCP server entry (ADR 0022). Optional: exotic
   *  deployments override; otherwise dev uses source, prod uses dist. */
  knowledgeMcpServerBin?: string;
  ompBin?: string;
  piBin?: string;
  piMcpAdapterPath?: string;
  claudeBin?: string;
  claudePermissionMode?: string;
  productToolsMcpUrl?: string;
  smokeCron?: string;
  /** Comma-separated built-in MCP servers to inject into agent workspaces
   *  (product-tools, workflow). Absent = product-tools only. */
  enabledMcpServers?: string;
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
    runTimeoutMs: env.BACKEND_RUN_TIMEOUT_MS ?? 30 * 60_000,
    builtinSkillsDir: process.env.BUILTIN_SKILLS_DIR ?? resolve(import.meta.dir, "../../../skills"),
    omaBin: env.OMA_BIN,
    knowledgeMcpServerBin: env.KNOWLEDGE_MCP_SERVER_BIN,
    piBin: env.PI_BIN,
    piMcpAdapterPath: env.PI_MCP_ADAPTER_PATH,
    claudeBin: env.CLAUDE_BIN,
    claudePermissionMode: env.CLAUDE_PERMISSION_MODE,
    productToolsMcpUrl: env.PRODUCT_TOOLS_MCP_URL,
    smokeCron: env.SMOKE_CRON,
    enabledMcpServers: env.ENABLED_MCP_SERVERS,
  };
}
