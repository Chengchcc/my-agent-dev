import type { Database } from "bun:sqlite";
import type { McpClientManager } from "@chengchenccc/adapter-mcp";
import { createMcpClientManager } from "@chengchenccc/adapter-mcp";
import type { BackendConfig } from "../config.js";
import { loadConfig } from "../config.js";
import type { LarkBotRegistry } from "../features/lark-bot/index.js";
import { createLarkBotRegistry } from "../features/lark-bot/lark-bot-registry-factory.js";
import { RuntimeOpsStore } from "../features/runtime-ops/index.js";
import type { SettingsService } from "../features/settings/index.js";
import { createSettingsService, sqliteSettingsAdapter } from "../features/settings/index.js";
import { openDb } from "../infra/sqlite/db.js";

export interface BackendServices {
  config: BackendConfig;
  db: Database;
  settingsSvc: SettingsService;
  mcpClientManager: McpClientManager;
  opsStore: RuntimeOpsStore;
  larkBotRegistry: LarkBotRegistry;
}

export function createBackendServices(config?: BackendConfig): BackendServices {
  const cfg = config ?? loadConfig();
  const db = openDb(`${cfg.dataDir}/backend.db`);

  const settingsSvc = createSettingsService({
    port: sqliteSettingsAdapter(db),
    config: cfg,
  });

  const mcpClientManager = createMcpClientManager();
  const opsStore = new RuntimeOpsStore(db);

  const larkBotRegistry = createLarkBotRegistry(cfg);

  return {
    config: cfg,
    db,
    settingsSvc,
    mcpClientManager,
    opsStore,
    larkBotRegistry,
  };
}
