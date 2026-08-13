import type { BackendModelRef } from "@my-agent-team/agent-backend";

export interface AgentRow {
  id: string;
  name: string;
  template: string | null;
  workspacePath: string;
  modelProvider: string;
  modelName: string;
  /** Execution backend kind (coding_agent / claude_code / pi / omp). The
   *  model ref derives from it; switching forks a new branch (D2). */
  backendKind: string;
  reasoningEffort: "none" | "low" | "high" | "max" | null;
  permissionMode: "ask" | "auto" | "deny";
  maxSteps: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  larkEnabled: boolean;
  larkAppId: string | null;
  larkProfileRef: string | null;
  larkBotDisplayName: string | null;
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
  reasoningEffort?: "none" | "low" | "high" | "max";
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
  lark?: {
    enabled?: boolean;
    appId?: string;
    appSecret?: string;
    botDisplayName?: string;
    /** profileRef is server-generated — never accepted from clients (§4.5). */
  };
}

/** Canonical Backend model reference for an Agent record. Catalogs key
 *  models as `<provider>/<model>`; the agent stores the bare provider and
 *  model name separately. The backendKind comes from the agent row (D2) —
 *  the kind the agent's branch is pinned to. */
export function agentModelRef(
  agent: Pick<AgentRow, "modelProvider" | "modelName" | "reasoningEffort" | "backendKind">,
): BackendModelRef {
  return {
    backendKind: agent.backendKind,
    modelId: `${agent.modelProvider}/${agent.modelName}`,
    ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
  };
}
