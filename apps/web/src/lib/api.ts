import type { WorkflowDefinition } from "@chengchenccc/workflow";
import { client, unwrap } from "./client";

// ── Types derived from API treaty (single source: backend App type) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ApiReturn<F extends (...args: any[]) => any> = Awaited<ReturnType<F>>;

export type AgentRunStatus =
  | "running"
  | "waiting"
  | "commit_failed"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout";

export type ProjectRow = ApiReturn<typeof api.listProjects>["projects"][number];
export type LarkSetupSession = ApiReturn<typeof api.larkSetup>;
export type AgentRow = ApiReturn<typeof api.listAgents>[number] & {
  enabled?: boolean;
  mcpServers?: Array<{ serverId: string; enabled: boolean }>;
  knowledgePacks?: string[];
  projects?: string[];
};
export type AgentRunDetail = ApiReturn<typeof api.getAgentRun>;
export type AgentRuntimeStatus = ApiReturn<typeof api.getAgentRuntime>;
export type SurfaceOpsItem = ApiReturn<typeof api.listSurfaces>[number];
export type ConversationSnapshot = ApiReturn<typeof api.listConversations>[number];
export type SettingsMap = ApiReturn<typeof api.getSettings>["settings"];
export type ProviderInfo = {
  id: string;
  name: string;
  apiKeyEnv: string;
  configured: boolean;
};
export type McpServerRow = ApiReturn<typeof api.listMcpServers>["mcpServers"][number];
export type PendingInput = ApiReturn<typeof api.listConversationInputs>["inputs"][number];
export type AgentMemory = {
  memories: Array<{ file: string; content: string }>;
  memSummary: string | null;
  memoryMd: string | null;
};
export type TelemetrySummary = {
  since: number;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolCalls: number;
  avgDurationMs: number;
  recent: Array<{
    runId: string;
    status: string;
    modelId: string;
    createdAt: number;
    durationMs: number | null;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byAgent: Array<{
    agentId: string;
    runs: number;
    completed: number;
    failed: number;
    successRate: number | null;
  }>;
  failures: Array<{
    runId: string;
    agentId: string;
    status: string;
    modelId: string;
    createdAt: number;
    durationMs: number | null;
    inputTokens: number;
    outputTokens: number;
    error: string | null;
  }>;
  costByHour: Array<{
    hour: number;
    costUsd: number;
    tokens: number;
  }>;
  byModel: Array<{
    modelId: string;
    runs: number;
    completed: number;
    failed: number;
    costUsd: number;
    tokens: number;
  }>;
  successRateByDay: Array<{
    dayStart: number;
    runs: number;
    completed: number;
    failed: number;
    successRate: number | null;
  }>;
  durationByDay: Array<{
    dayStart: number;
    runs: number;
    avgDurationMs: number | null;
  }>;
  failureCauses: Array<{
    cause: string;
    count: number;
  }>;
  spinningRuns: Array<{
    runId: string;
    status: string;
    modelId: string;
    toolCalls: number;
    durationMs: number | null;
    outputTokens: number;
  }>;
};

export type ChatModelOverride = {
  backendKind: string;
  modelId: string;
  reasoningEffort?: "none" | "low" | "high" | "max";
};

export type SystemInfo = ApiReturn<typeof api.getSystemInfo>;
export type WorkflowDefinitionRow = ApiReturn<
  typeof api.listWorkflowDefinitions
>["definitions"][number];

/** Extract fork source ID from a conversation snapshot (null when not a fork). */
export function getForkSourceId(conv: ConversationSnapshot): string | null {
  return typeof conv.forkSource === "string" ? conv.forkSource : null;
}

export function classifyError(e: unknown) {
  if (e instanceof Error && e.name === "ApiError") {
    const ae = e as Error & { status: number };
    if (ae.status === 401) return "unauthorized";
    if (ae.status === 404) return "not_found";
    if (ae.status >= 500) return "backend_unavailable";
  }
  return "unknown";
}

// ── API client (treaty-based — single source: backend App type) ──

export const api = {
  // Agents
  listAgents: () => unwrap(client.api.agents.get()),
  getAgent: (id: string) => unwrap(client.api.agents({ id }).get()),
  createAgent: (body: Parameters<typeof client.api.agents.post>[0]) =>
    unwrap(client.api.agents.post(body)),
  updateAgent: (id: string, body: Record<string, unknown>) =>
    unwrap(client.api.agents({ id }).patch(body)),
  archiveAgent: (id: string) => unwrap(client.api.agents({ id }).delete()),
  getIdentity: (id: string) => unwrap(client.api.agents({ id }).identity.get()),
  setIdentity: (id: string, body: { soul?: string; user?: string }) =>
    unwrap(client.api.agents({ id }).identity.put(body)),
  // Lark setup
  larkSetup: (id: string, body: { botDisplayName?: string; brand?: "feishu" | "lark" }) =>
    unwrap(client.api.agents({ id }).lark.setup.post(body)),
  larkSetupStatus: (id: string, setupId: string) =>
    unwrap(client.api.agents({ id }).lark.setup({ setupId }).get()),
  larkSetupCancel: (id: string, setupId: string) =>
    unwrap(client.api.agents({ id }).lark.setup({ setupId }).delete()),
  // Conversations
  listConversations: (agentId?: string) =>
    unwrap(client.api.conversations.get({ query: agentId ? { agentId } : undefined })),
  createConversation: (body: {
    conversationId?: string;
    projectId?: string;
    agentId: string;
    origin?: string;
  }) => unwrap(client.api.conversations.post(body)),
  getConversation: (id: string) => unwrap(client.api.conversations({ id }).get()),
  postConversationMessage: (
    id: string,
    body: {
      content: unknown;
      mode?: "normal" | "steer" | "follow_up";
      model?: ChatModelOverride;
    },
  ) => unwrap(client.api.conversations({ id }).messages.post(body)),
  listConversationInputs: (id: string) => unwrap(client.api.conversations({ id }).inputs.get()),
  steerConversationInput: (id: string, inputId: string) =>
    unwrap(client.api.conversations({ id }).inputs({ inputId }).steer.post()),
  updateConversationInput: (id: string, inputId: string, text: string) =>
    unwrap(client.api.conversations({ id }).inputs({ inputId }).patch({ text })),
  cancelConversationInput: (id: string, inputId: string) =>
    unwrap(client.api.conversations({ id }).inputs({ inputId }).cancel.post()),
  deleteConversation: (id: string) => unwrap(client.api.conversations({ id }).delete()),
  clearConversation: (id: string) => unwrap(client.api.conversations({ id }).clear.post({})),
  compactConversation: (id: string) => unwrap(client.api.conversations({ id }).compact.post({})),
  updateConversation: (id: string, body: { title?: string }) =>
    unwrap(client.api.conversations({ id }).patch(body)),
  searchConversations: (q: string) => unwrap(client.api.conversations.search.get({ query: { q } })),
  exportConversation: async (id: string) => {
    const resp = await fetch(`/api/bff/api/conversations/${id}/export`, { credentials: "include" });
    if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);
    return resp.text();
  },
  // Ops — Agent Run is the only execution identity
  listAgentRuns: (params?: {
    status?: AgentRunStatus;
    agentId?: string;
    conversationId?: string;
    limit?: number;
  }) =>
    unwrap(
      client.api["agent-runs"].get({
        query: params
          ? {
              status: params.status,
              agentId: params.agentId,
              conversationId: params.conversationId,
              limit: params.limit != null ? String(params.limit) : undefined,
            }
          : undefined,
      }),
    ),
  getAgentRun: (runId: string) => unwrap(client.api["agent-runs"]({ runId }).get()),
  cancelAgentRun: (runId: string) => unwrap(client.api["agent-runs"]({ runId }).cancel.post()),
  resolveApproval: (runId: string, callId: string, decision: "allow" | "deny") =>
    unwrap(
      client.api["agent-runs"]({ runId }).approval.post({
        callId,
        decision,
      }),
    ),
  getUsageSummary: (scope: { conversationId?: string; agentId?: string }) =>
    unwrap(
      client.api.usage.summary.get({
        query:
          scope.conversationId || scope.agentId
            ? {
                conversationId: scope.conversationId || undefined,
                agentId: scope.agentId || undefined,
              }
            : undefined,
      }),
    ),
  getAgentRuntime: (agentId: string) =>
    unwrap(client.api.ops.agents({ id: agentId }).runtime.get()),
  listSurfaces: () => unwrap(client.api.ops.surfaces.get()),
  getTelemetrySummary: (since?: number) =>
    fetch(`/api/bff/telemetry/summary${since ? `?since=${since}` : ""}`, {
      credentials: "include",
    }).then((r) => r.json()) as Promise<TelemetrySummary>,
  getRunTelemetry: (runId: string) =>
    fetch(`/api/bff/agent-runs/${runId}/telemetry`, { credentials: "include" }).then((r) =>
      r.json(),
    ),
  // Projects
  listProjects: () => unwrap(client.api.projects.get()),
  getProject: (id: string) => unwrap(client.api.projects({ id }).get()),
  listProjectWorktrees: (id: string) => unwrap(client.api.projects({ id }).worktrees.get()),
  projectWorktreeDiff: (id: string, agentId: string) =>
    unwrap(client.api.projects({ id }).worktrees({ agentId }).diff.get()),
  projectWorktreeFastForward: (id: string, agentId: string, push: boolean) =>
    unwrap(client.api.projects({ id }).worktrees({ agentId })["fast-forward"].post({ push })),
  projectWorktreeMerge: (id: string, agentId: string, push: boolean) =>
    unwrap(client.api.projects({ id }).worktrees({ agentId }).merge.post({ push })),
  createProject: (body: { name: string; repoUrl?: string; defaultBranch?: string }) =>
    unwrap(client.api.projects.post(body)),
  updateProject: (
    id: string,
    body: {
      name?: string;
      repoUrl?: string | null;
      defaultBranch?: string | null;
    },
  ) => unwrap(client.api.projects({ id }).patch(body)),
  deleteProject: (id: string) => unwrap(client.api.projects({ id }).delete()),
  // Skill packs
  listSkillPacks: () => unwrap(client.api["skill-packs"].get()),
  getSkillPackSkills: (id: string) => unwrap(client.api["skill-packs"]({ id }).skills.get()),
  getSkillPackFiles: (id: string, path?: string) =>
    unwrap(client.api["skill-packs"]({ id }).files.get({ query: path ? { path } : undefined })),
  searchSkillPack: (id: string, q: string) =>
    unwrap(client.api["skill-packs"]({ id }).search.get({ query: { q } })),
  installSkillPackGit: (body: { name: string; description: string; url: string; ref?: string }) =>
    unwrap(client.api["skill-packs"].git.post(body)),
  uploadSkillPackZip: (body: { name: string; description: string; file: File }) =>
    unwrap(client.api["skill-packs"].upload.post(body)),
  syncSkillPack: (id: string, confirm = false) =>
    unwrap(client.api["skill-packs"]({ id }).sync.post({ confirm })),
  deleteSkillPack: (id: string) => unwrap(client.api["skill-packs"]({ id }).delete()),
  getAgentSkillPacks: (agentId: string) =>
    unwrap(client.api.agents({ id: agentId })["skill-packs"].get()),
  setAgentSkillPacks: (agentId: string, body: { packIds: string[] }) =>
    unwrap(client.api.agents({ id: agentId })["skill-packs"].put(body)),
  // Settings
  getSettings: () => unwrap(client.api.settings.get()),
  getSystemInfo: () => unwrap(client.api.settings.system.get()),
  updateSetting: (key: string, value: unknown) =>
    unwrap(client.api.settings({ key }).put({ value })),
  currentUser: async () => {
    const r = await fetch("/api/auth/session", { credentials: "include" });
    if (!r.ok) throw new Error("Session expired");
    return (await r.json()) as { userId: string };
  },
  // MCP catalog (ADR 0022, direct fetch - global routes)
  listMcpServers: () =>
    fetch("/api/bff/mcp-servers", { credentials: "include" }).then((r) => r.json()),
  getMcpServer: (serverId: string) =>
    fetch(`/api/bff/mcp-servers/${serverId}`, { credentials: "include" }).then((r) => r.json()),
  createMcpServer: (body: {
    name: string;
    transport: "stdio" | "sse";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
    url?: string;
  }) =>
    fetch("/api/bff/mcp-servers", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  updateMcpServer: (
    serverId: string,
    body: {
      name?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      headers?: Record<string, string>;
      url?: string;
    },
  ) =>
    fetch(`/api/bff/mcp-servers/${serverId}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  testMcpServer: (serverId: string) =>
    fetch(`/api/bff/mcp-servers/${serverId}/test`, {
      method: "POST",
      credentials: "include",
    }).then((r) => r.json()),
  getMcpToolCatalog: (serverId: string) =>
    unwrap(client.api["mcp-servers"]({ serverId }).tools.get()),
  invokeMcpTool: (serverId: string, body: { tool: string; args?: Record<string, unknown> }) =>
    fetch(`/api/bff/mcp-servers/${serverId}/tools/invoke`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  restartMcpServer: (serverId: string) =>
    fetch(`/api/bff/mcp-servers/${serverId}/restart`, {
      method: "POST",
      credentials: "include",
    }).then((r) => r.json()),
  resolveHumanTasks: (decisions: Array<{ executionId: string; nodeId: string }>) =>
    fetch(`/api/bff/workflow-executions/human-tasks/batch-resolve`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions }),
    }).then((r) => r.json()),
  getSystemMetrics: () => unwrap(client.api.ops["system-metrics"].get()),
  deleteMcpServer: (serverId: string) =>
    fetch(`/api/bff/mcp-servers/${serverId}`, {
      method: "DELETE",
      credentials: "include",
    }).then((r) => r.ok),
  // Knowledge packs (ADR 0022, direct fetch)
  listKnowledgePacks: () =>
    fetch("/api/bff/knowledge-packs", { credentials: "include" }).then((r) => r.json()),
  knowledgeStats: (packId: string) =>
    unwrap(client.api["knowledge-packs"]({ id: packId }).stats.get()),
  knowledgeAllStats: async () => {
    const r = await fetch("/api/bff/knowledge-packs/stats", { credentials: "include" });
    if (!r.ok) throw new Error(`stats failed: ${r.status}`);
    return (await r.json()) as Array<{
      packId: string;
      files: number;
      totalBytes: number;
      estTokens: number;
    }>;
  },
  installKnowledgePack: (body: {
    name: string;
    description?: string;
    sourceKind: "builtin" | "git" | "zip";
    sourceUrl?: string;
  }) =>
    fetch("/api/bff/knowledge-packs/install", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  deleteKnowledgePack: (id: string) =>
    fetch(`/api/bff/knowledge-packs/${id}`, {
      method: "DELETE",
      credentials: "include",
    }).then((r) => r.ok),
  // Memory
  getAgentMemory: (agentId: string) =>
    fetch(`/api/bff/agents/${agentId}/memory`, { credentials: "include" }).then((r) => r.json()),
  updateAgentMemory: (
    agentId: string,
    body: {
      memSummary?: string;
      memoryMd?: string;
      facts?: Array<{ file: string; content: string }>;
      deleteFacts?: string[];
    },
  ) =>
    fetch(`/api/bff/agents/${agentId}/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    }).then((r) => r.json()),
  // Workspace (read-only file browser, ADR 0003)
  listWorkspaceEntries: (agentId: string, path: string) =>
    fetch(`/api/bff/agents/${agentId}/workspace/entries?path=${encodeURIComponent(path)}`, {
      credentials: "include",
    }).then((r) => r.json()),
  readWorkspaceFile: (agentId: string, path: string) =>
    fetch(`/api/bff/agents/${agentId}/workspace/file?path=${encodeURIComponent(path)}`, {
      credentials: "include",
    }).then((r) => r.json()),
  // Models (direct fetch - route not visible to Eden treaty)
  listModels: async () => {
    const resp = await fetch("/api/bff/models", { credentials: "include" });
    return (await resp.json()) as {
      providers: Array<{
        id: string;
        name: string;
        baseUrl?: string;
        models: Array<{
          id: string;
          name: string;
          reasoning: boolean;
          input: string[];
          cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
          contextWindow: number;
          maxTokens: number;
          available?: boolean;
          backendKind: string;
        }>;
      }>;
    };
  },
  // Providers (direct fetch - route not visible to Eden treaty)
  listProviders: async () => {
    const resp = await fetch("/api/bff/providers", { credentials: "include" });
    return (await resp.json()) as { providers: ProviderInfo[] };
  },
  setProvider: async (id: string, body: { apiKey?: string; baseUrl?: string }) => {
    const resp = await fetch(`/api/bff/providers/${id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Failed to save provider: ${resp.status}`);
    return (await resp.json()) as { ok: boolean; provider: ProviderInfo };
  },
  clearProvider: async (id: string) => {
    const resp = await fetch(`/api/bff/providers/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!resp.ok) throw new Error(`Failed to clear provider: ${resp.status}`);
    return (await resp.json()) as { ok: boolean };
  },
  // Conversation fork/undo/replay (direct fetch - new routes)
  forkConversation: async (id: string, fromSeq: number, title?: string) => {
    const resp = await fetch(`/api/bff/conversations/${id}/fork`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromSeq, ...(title ? { title } : {}) }),
    });
    return (await resp.json()) as { newConversationId: string };
  },
  undoMessages: async (id: string, count = 1) => {
    const resp = await fetch(`/api/bff/conversations/${id}/undo`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count }),
    });
    return (await resp.json()) as { undoneSeqs: number[] };
  },
  replayFromMessage: async (id: string, fromSeq: number, editedContent: string) => {
    const resp = await fetch(`/api/bff/conversations/${id}/replay`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromSeq, editedContent }),
    });
    return (await resp.json()) as { newConversationId: string };
  },
  // Workflow
  listWorkflowDefinitions: () => unwrap(client.api["workflow-definitions"].get()),
  getWorkflowDefinition: (workflowId: string) =>
    unwrap(client.api["workflow-definitions"]({ workflowId }).get()),
  saveWorkflowDefinition: (workflowId: string, definition: Record<string, unknown>) =>
    unwrap(client.api["workflow-definitions"]({ workflowId }).put({ definition })),
  chatPatchWorkflow: async (
    workflowId: string,
    definition: unknown,
    instruction: string,
  ): Promise<{ definition: WorkflowDefinition }> => {
    const resp = await fetch(
      `/api/bff/api/workflow-definitions/${encodeURIComponent(workflowId)}/chat-patch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition, instruction }),
      },
    );
    if (!resp.ok) throw new Error(`chat-patch failed: ${resp.status}`);
    return (await resp.json()) as {
      definition: WorkflowDefinition;
    };
  },
  dryRunWorkflow: (
    workflowId: string,
    body: {
      input?: Record<string, unknown>;
      mockOutputs?: Record<string, Record<string, unknown>>;
      startNodeId?: string;
    },
  ) => unwrap(client.api["workflow-definitions"]({ workflowId })["dry-run"].post(body)),
  deleteWorkflowDefinition: (workflowId: string) =>
    unwrap(client.api["workflow-definitions"]({ workflowId }).delete()),
  listWorkflowExecutions: (workflowId?: string) =>
    unwrap(
      client.api["workflow-executions"].get({ query: workflowId ? { workflowId } : undefined }),
    ),
  startWorkflowExecution: (body: {
    workflowRef: { repo: string; path: string };
    input?: Record<string, unknown>;
    artifacts?: string[];
  }) => unwrap(client.api["workflow-executions"].post(body)),
  getWorkflowExecutionTrace: (executionId: string) =>
    unwrap(client.api["workflow-executions"]({ executionId }).trace.get()),
  cancelWorkflowExecution: (executionId: string) =>
    unwrap(client.api["workflow-executions"]({ executionId }).cancel.post({})),
  deleteWorkflowExecution: (executionId: string) =>
    unwrap(client.api["workflow-executions"]({ executionId }).delete()),
  resolveWorkflowHumanTask: (
    executionId: string,
    body: { nodeId: string; answer?: Record<string, unknown> },
  ) => unwrap(client.api["workflow-executions"]({ executionId })["human-task"].post(body)),
  resolveProductAsk: (body: {
    runId: string;
    callId: string;
    answer: {
      answers: Array<{
        id: string;
        selectedValues: string[];
        freeText?: string;
      }>;
    };
  }) =>
    fetch("/api/bff/api/product-tools/ask/resolve", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  listArtifacts: async (folder?: string) => {
    const qs = folder ? `?folder=${encodeURIComponent(folder)}` : "";
    const r = await fetch(`/api/bff/api/artifacts${qs}`);
    if (!r.ok) throw new Error(`list artifacts failed: ${r.status}`);
    return (await r.json()) as { artifacts: ArtifactMeta[] };
  },
  uploadArtifact: async (body: {
    folder: string;
    filename: string;
    content: string;
    encoding?: "utf8" | "base64";
  }) => {
    const r = await fetch("/api/bff/api/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`upload artifact failed: ${r.status}`);
    return (await r.json()) as ArtifactMeta;
  },
  downloadArtifact: async (url: string) => {
    // Query param (not path segment): the artifacts:// URL contains '/'
    // which a path param cannot match, and double-encoding through the BFF
    // can decode %2F back into slashes.
    const r = await fetch(`/api/bff/api/artifacts/download?url=${encodeURIComponent(url)}`);
    if (!r.ok) throw new Error(`download artifact failed: ${r.status}`);
    return (await r.json()) as {
      content: string;
      encoding: string;
      mimeType: string;
      size: number;
    };
  },
  deleteArtifact: async (url: string) => {
    // Query param, same as download: the artifacts:// URL contains '/' which
    // a path segment cannot match (this exact bug broke delete with 404).
    const r = await fetch(`/api/bff/api/artifacts/remove?url=${encodeURIComponent(url)}`, {
      method: "DELETE",
    });
    if (!r.ok) throw new Error(`delete artifact failed: ${r.status}`);
    return (await r.json()) as { ok: boolean };
  },
};

export type ArtifactMeta = {
  url: string;
  folder: string;
  filename: string;
  size: number;
  mimeType: string;
  encoding: "utf8" | "base64";
  updatedAt: number;
  source?: { runId?: string; conversationId?: string; agentId?: string };
};
