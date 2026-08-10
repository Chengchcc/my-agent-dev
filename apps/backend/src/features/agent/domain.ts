export interface AgentRow {
  id: string;
  name: string;
  template: string | null;
  workspacePath: string;
  modelProvider: string;
  modelName: string;
  modelBaseUrl: string | null;
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
  model: { provider: string; model: string; baseURL?: string };
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

/** Canonical Backend model reference for an Agent record. The Coding Agent
 *  catalog keys models as `<provider>/<model>`; the agent stores the bare
 *  provider and model name separately. */
export function agentModelRef(agent: Pick<AgentRow, "modelProvider" | "modelName">): {
  backendKind: "coding_agent";
  modelId: string;
} {
  return {
    backendKind: "coding_agent",
    modelId: `${agent.modelProvider}/${agent.modelName}`,
  };
}
