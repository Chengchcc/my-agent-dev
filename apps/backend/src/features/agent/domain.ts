import type { BackendModelRef } from "@my-agent-team/agent-backend";
import type { AgentConfig } from "./agent-config.js";

/** Agent row (file-first, ADR 0020 decision 1): the DB keeps only the FK
 *  anchor (id), the workspace location, and a materialized cache of the
 *  parsed `agent.yml` (`config`). */
export interface AgentRow {
  id: string;
  workspacePath: string;
  config: AgentConfig;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface CreateAgentInput {
  /** Optional explicit id; used by the bootstrap seed to create a stable "default" agent.
   *  Not accepted from HTTP clients — the POST /api/agents body schema omits this field. */
  id?: string;
  name: string;
  template?: string;
  model: { provider: string; model: string };
  backendKind?: string;
  /** Optional workspace override (agent-hub 预留): an absolute path the
   *  coding agent runs in (its AGENTS.md/CLAUDE.md take effect there).
   *  Defaults to the managed <dataDir>/agents/<id>. */
  workspacePath?: string;
  reasoningEffort?: "none" | "low" | "high" | "max" | null;
  permissionMode?: "ask" | "auto" | "deny";
  maxSteps?: number;
  lark?: {
    enabled: boolean;
    appId?: string;
    appSecret?: string;
    botDisplayName?: string;
  };
}

export interface UpdateAgentInput {
  name?: string;
  model?: { provider: string; model: string };
  backendKind?: string;
  workspacePath?: string;
  reasoningEffort?: "none" | "low" | "high" | "max" | null;
  permissionMode?: "ask" | "auto" | "deny";
  maxSteps?: number;
  mcpServers?: Array<{ serverId: string; enabled: boolean }>;
  knowledgePacks?: string[];
  projects?: string[];
  lark?: {
    enabled?: boolean;
    appId?: string;
    appSecret?: string;
    botDisplayName?: string;
    /** profileRef is server-generated — never accepted from clients (§4.5). */
  };
}

/** Canonical Backend model reference for an Agent record. Reads from the
 *  materialized agent.yml config (runtime_config) — the file is the
 *  source (ADR 0020). */
export function agentModelRef(agent: Pick<AgentRow, "config">): BackendModelRef {
  const rc = agent.config.runtime_config;
  return {
    backendKind: rc.runtime,
    modelId: rc.model_id,
    ...(rc.reasoning_effort !== "" ? { reasoningEffort: rc.reasoning_effort } : {}),
  };
}
