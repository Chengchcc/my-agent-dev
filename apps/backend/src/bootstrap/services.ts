import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { McpClientManager } from "@my-agent-team/adapter-mcp";
import { createMcpClientManager } from "@my-agent-team/adapter-mcp";
import type { SessionManager } from "@my-agent-team/agent";
import { SqliteSessionManager } from "@my-agent-team/agent";
import type { ModelRegistry, ProviderAuth } from "@my-agent-team/ai";
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
import { createDefaultModelRegistry } from "../features/span/agent-helpers.js";
import type { SpanSupervisor as SpanSupervisorType } from "../features/span/supervisor.js";
import { SpanSupervisor } from "../features/span/supervisor.js";
import { openDb } from "../infra/sqlite/db.js";

export interface BackendServices {
  config: BackendConfig;
  db: Database;
  settingsSvc: SettingsService;
  modelRegistry: ModelRegistry;
  anthropicAuth: ProviderAuth;
  mcpClientManager: McpClientManager;
  tracer: RuntimeTracer;
  opsStore: RuntimeOpsStore;
  supervisor: SpanSupervisorType;
  sessionManager: SessionManager;
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

  const modelRegistry = createDefaultModelRegistry(cfg);
  const anthropicAuth = { apiKey: cfg.anthropicApiKey, baseUrl: cfg.anthropicBaseUrl };
  const mcpClientManager = createMcpClientManager();

  const obsConfig = resolveObservabilityConfig({ serviceName: "backend" });
  const tracer = createRuntimeTracer(obsConfig);
  const opsStore = new RuntimeOpsStore(db);

  // Mutual dependency: supervisor needs sessionManager for onReap,
  // sessionManager needs supervisor for startSpan.
  // eslint-disable-next-line prefer-const
  let sessionManager: SessionManager;

  const supervisor = new SpanSupervisor({
    config: cfg,
    opsStore,
    tracer,
    db,
    onReap: (_runId: string, sid: string) => sessionManager.dispose(sid),
  });

  sessionManager = new SqliteSessionManager({
    checkpointerPath: join(cfg.dataDir, "checkpointer.db"),
    startSpan: (sid: string, sid2: string, opts?: unknown) => supervisor.startSpan(sid, sid2, opts),
  });

  const larkBotRegistry = createLarkBotRegistry(cfg);

  return {
    config: cfg,
    db,
    settingsSvc,
    modelRegistry,
    anthropicAuth,
    mcpClientManager,
    tracer,
    opsStore,
    supervisor,
    sessionManager,
    loopStore,
    larkBotRegistry,
  };
}
