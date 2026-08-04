import type { Database } from "bun:sqlite";
import type { McpClientManager } from "@my-agent-team/adapter-mcp";
import { createMcpClientManager } from "@my-agent-team/adapter-mcp";
import type { RuntimeTracer } from "@my-agent-team/runtime-observability";
import {
  createRuntimeTracer,
  resolveObservabilityConfig,
} from "@my-agent-team/runtime-observability";
import type { BackendConfig } from "../config.js";
import { loadConfig } from "../config.js";
import type { LarkBotRegistry } from "../features/lark-bot/index.js";
import { createLarkBotRegistry } from "../features/lark-bot/lark-bot-registry-factory.js";
import type { LoopStateStore } from "../features/loop/loop-state-store.js";
import { createLoopStateStore } from "../features/loop/loop-state-store.js";
import { RuntimeOpsStore } from "../features/runtime-ops/index.js";
import type { SettingsService } from "../features/settings/index.js";
import { createSettingsService, sqliteSettingsAdapter } from "../features/settings/index.js";
import { openDb } from "../infra/sqlite/db.js";

export interface BackendServices {
  config: BackendConfig;
  db: Database;
  settingsSvc: SettingsService;
  mcpClientManager: McpClientManager;
  tracer: RuntimeTracer;
  opsStore: RuntimeOpsStore;
  loopStore: LoopStateStore;
  larkBotRegistry: LarkBotRegistry;
}

export function createBackendServices(config?: BackendConfig): BackendServices {
  const cfg = config ?? loadConfig();
  const db = openDb(`${cfg.dataDir}/backend.db`);
  const loopStore = createLoopStateStore(db);

  const settingsSvc = createSettingsService({
    port: sqliteSettingsAdapter(db),
    config: cfg,
  });

  const mcpClientManager = createMcpClientManager();

  const obsConfig = resolveObservabilityConfig({ serviceName: "backend" });
  const tracer = createRuntimeTracer(obsConfig);
  const opsStore = new RuntimeOpsStore(db);

  const larkBotRegistry = createLarkBotRegistry(cfg);

  return {
    config: cfg,
    db,
    settingsSvc,
    mcpClientManager,
    tracer,
    opsStore,
    loopStore,
    larkBotRegistry,
  };
}
