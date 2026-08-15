import type { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { BackendConfig } from "../../config.js";
import { ulid } from "../../infra/ids.js";
import { type LarkBotRegistry, larkProfileInit } from "../lark-bot/index.js";
import { sqliteAgentAdapter } from "./adapter-sqlite.js";
import { withLarkLifecycle } from "./agent-lark.js";
import type { AgentService } from "./index.js";
import { createAgentService } from "./index.js";
import { ensureAgentWorkspace } from "./workspace.js";

/** Create the full agent service with workspace materialization, hard-delete
 *  dependencies, lark-bot orchestration, and optional onCreate hook.
 *  The busy guard is injected as a function so features.ts can wire the
 *  Agent Run query once the run adapter exists (no circular composition). */
export function createAgentSvc(
  db: Database,
  config: BackendConfig,
  larkBotRegistry: LarkBotRegistry,
  opts?: {
    onAgentCreate?: (agentId: string) => Promise<void>;
    /** Called after agent update (workspace-bridge reconcile). */
    onAgentUpdate?: (agentId: string, prevProjects: string[]) => Promise<void>;
    /** Throws when the agent has an active Agent Run. Defaults to no-op. */
    assertNoActiveRun?: (agentId: string) => void;
  },
): AgentService {
  const agentPort = sqliteAgentAdapter(db);
  const agentsDir = join(config.dataDir, "agents");

  const agentSvcRaw = createAgentService({
    port: agentPort,
    idGen: ulid,
    workspaceRoot: config.workspaceRoot,
    allowedWorkspaceRoots: [config.workspaceRoot, join(config.dataDir, "agents")],
    onCreate: opts?.onAgentCreate,
    onUpdate: opts?.onAgentUpdate,
    materializeWorkspace: async (agentId) => {
      return ensureAgentWorkspace(join(agentsDir, agentId));
    },

    purgeWorkspace: async (agentId) => {
      const dir = join(agentsDir, agentId);
      await rm(dir, { recursive: true, force: true });
    },

    assertNoActiveRun: (agentId) => {
      opts?.assertNoActiveRun?.(agentId);
    },
  });

  return withLarkLifecycle({
    service: agentSvcRaw,
    profileInit: larkProfileInit,
    ensureBot: (id, botDisplayName, larkProfile) =>
      larkBotRegistry.ensureLarkBot(id, botDisplayName, larkProfile),
    stopBot: (id) => larkBotRegistry.stopLarkBot(id),
  });
}
