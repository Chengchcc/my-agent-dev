import type { BackendConfig } from "../../config.js";
import type { SettingsRow } from "./domain.js";
import type { SettingsPort } from "./ports.js";

export interface SystemInfo {
  env: Record<string, string>;
  paths: Record<string, string>;
}

export interface SettingsService {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  getAll(): Record<string, unknown>;
  getSystemInfo(): SystemInfo;
}

function maskSecret(v: string): string {
  return v.length > 4 ? `****${v.slice(-4)}` : "****";
}

function isSecretKey(k: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD/i.test(k);
}

export function createSettingsService(deps: {
  port: SettingsPort;
  config: BackendConfig;
}): SettingsService {
  const { port, config } = deps;

  return {
    get<T>(key: string): T | undefined {
      const row = port.get(key);
      if (!row) return undefined;
      try {
        return JSON.parse(row.value) as T;
      } catch {
        return undefined;
      }
    },

    set<T>(key: string, value: T): void {
      port.set(key, JSON.stringify(value));
    },

    getAll(): Record<string, unknown> {
      const rows: SettingsRow[] = port.getAll();
      const result: Record<string, unknown> = {};
      for (const row of rows) {
        try {
          result[row.key] = JSON.parse(row.value);
        } catch {
          // skip unparseable
        }
      }
      return result;
    },

    getSystemInfo(): SystemInfo {
      const env = process.env;
      const envOut: Record<string, string> = {};
      const envKeys = [
        "BACKEND_HOST",
        "BACKEND_PORT",
        "BACKEND_DATA_DIR",
        "BACKEND_WORKSPACE_ROOT",
        "BACKEND_TEMPLATE_DIR",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "NODE_ENV",
        "RUNNER_ENV",
      ];
      for (const k of envKeys) {
        const v = env[k];
        if (v === undefined) continue;
        envOut[k] = isSecretKey(k) ? maskSecret(v) : v;
      }

      return {
        env: envOut,
        paths: {
          dataDir: config.dataDir,
          workspaceRoot: config.workspaceRoot,
          agentWorkspace: `${config.dataDir}/agents/:id`,
          skillPacks: `${config.dataDir}/skill-packs`,
          backendDb: `${config.dataDir}/backend.db`,
          builtinSkills: config.builtinSkillsDir,
        },
      };
    },
  };
}
