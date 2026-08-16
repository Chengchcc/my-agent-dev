import type { LedgerEntry, Member } from "@my-agent-team/conversation";
import type { ContentBlock } from "@my-agent-team/message";
import { client, unwrap } from "./client";

// ── Types derived from API treaty (single source: backend App type) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiReturn<F extends (...args: any[]) => any> = Awaited<ReturnType<F>>;

export type AgentRunStatus =
  | "running"
  | "waiting"
  | "commit_failed"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout";

export type ProjectRow = ApiReturn<typeof api.listProjects>["projects"][number];
export type CronJobRow = ApiReturn<typeof api.listCronJobs>["cronJobs"][number];
export type LoopRow = ApiReturn<typeof api.listLoops>["loops"][number];
export type LoopDetail = ApiReturn<typeof api.getLoop>["loop"];
export type LarkSetupSession = ApiReturn<typeof api.larkSetup>;
export type AgentRow = ApiReturn<typeof api.listAgents>[number] & {
  mcpServers?: Array<{ serverId: string; enabled: boolean }>;
  knowledgePacks?: string[];
  projects?: string[];
};
export type AgentRunDetail = ApiReturn<typeof api.getAgentRun>;
export type AgentRuntimeStatus = ApiReturn<typeof api.getAgentRuntime>;
export type SurfaceOpsItem = ApiReturn<typeof api.listSurfaces>[number];
export type ConversationSnapshot = ApiReturn<typeof api.listConversations>[number];
export type ReviewQueueItem = ApiReturn<typeof api.getWorkToday>["reviewQueue"][number];
export type CreateLoopResult = ApiReturn<typeof api.createLoop>;
export type RefineLoopResult = ApiReturn<typeof api.refineLoop>;
export type ActivateLoopResult = ApiReturn<typeof api.activateLoop>;
export type SettingsMap = ApiReturn<typeof api.getSettings>["settings"];
export type McpServerRow = ApiReturn<typeof api.listMcpServers>["mcpServers"][number];

export type SystemInfo = ApiReturn<typeof api.getSystemInfo>;

export type { ContentBlock };
export type MemberInfo = Member;
export type { LedgerEntry };
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
    members: Array<{
      memberId?: string;
      kind: "agent" | "human";
      agentId?: string;
      userRef?: string;
      displayName?: string;
    }>;
  }) => unwrap(client.api.conversations.post(body)),
  getConversation: (id: string) => unwrap(client.api.conversations({ id }).get()),
  postConversationMessage: (
    id: string,
    body: { senderMemberId: string; addressedTo: string[]; content: unknown },
  ) => unwrap(client.api.conversations({ id }).messages.post(body)),
  addConversationMember: (
    id: string,
    body: { memberId: string; kind: "agent" | "human"; agentId?: string; displayName?: string },
  ) => unwrap(client.api.conversations({ id }).members.post(body)),
  removeConversationMember: (id: string, memberId: string) =>
    unwrap(client.api.conversations({ id }).members.delete({ memberId })),
  deleteConversation: (id: string) => unwrap(client.api.conversations({ id }).delete()),
  clearConversation: (id: string) => unwrap(client.api.conversations({ id }).clear.post({})),
  compactConversation: (id: string) => unwrap(client.api.conversations({ id }).compact.post({})),
  updateConversation: (id: string, body: { title?: string }) =>
    unwrap(client.api.conversations({ id }).patch(body)),
  getGoal: (conversationId: string) =>
    unwrap(client.api.conversations({ id: conversationId }).goal.get()),
  setGoal: (
    conversationId: string,
    body: { action: "set" | "clear" | "pause" | "resume"; condition?: string },
  ) => unwrap(client.api.conversations({ id: conversationId }).goal.post(body)),
  searchConversations: (q: string) => unwrap(client.api.conversations.search.get({ query: { q } })),
  exportConversation: async (id: string) => {
    const resp = await fetch(`/api/bff/api/conversations/${id}/export`, { credentials: "include" });
    if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);
    return resp.text();
  },
  // Ops — Agent Run is the only execution identity
  listAgentRuns: (params?: { status?: AgentRunStatus; agentId?: string; limit?: number }) =>
    unwrap(
      client.api["agent-runs"].get({
        query: params
          ? {
              status: params.status,
              agentId: params.agentId,
              limit: params.limit != null ? String(params.limit) : undefined,
            }
          : undefined,
      }),
    ),
  getAgentRun: (runId: string) => unwrap(client.api["agent-runs"]({ runId }).get()),
  cancelAgentRun: (runId: string) => unwrap(client.api["agent-runs"]({ runId }).cancel.post()),
  getAgentRuntime: (agentId: string) =>
    unwrap(client.api.ops.agents({ id: agentId }).runtime.get()),
  listSurfaces: () => unwrap(client.api.ops.surfaces.get()),
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
  // Cron Jobs
  listCronJobs: () => unwrap(client.api["cron-jobs"].get()),
  createCronJob: (body: {
    name: string;
    agentId: string;
    cronExpr: string;
    prompt?: string;
    timeoutMs?: number;
    maxRetries?: number;
    enabled?: boolean;
  }) => unwrap(client.api["cron-jobs"].post(body)),
  updateCronJob: (
    id: string,
    body: {
      name?: string;
      prompt?: string;
      cronExpr?: string;
      timeoutMs?: number;
      maxRetries?: number;
      enabled?: boolean;
    },
  ) => unwrap(client.api["cron-jobs"]({ id }).patch(body)),
  setCronJobEnabled: (id: string, enabled: boolean) =>
    unwrap(client.api["cron-jobs"]({ id }).enable.post({ enabled })),
  deleteCronJob: (id: string) => unwrap(client.api["cron-jobs"]({ id }).delete()),
  // Loops
  listLoops: () => unwrap(client.api.loops.get()),
  getLoop: (id: string) => unwrap(client.api.loops({ id }).get()),
  createLoop: (body: { name: string; intent?: string; projectId?: string; cronExpr?: string }) =>
    unwrap(client.api.loops.post(body)),
  runLoop: (id: string) => unwrap(client.api.loops({ id }).run.post({})),
  reviewLoopItem: (
    id: string,
    body: {
      verdict: "approve" | "reject" | "promote" | "retry" | "dismiss";
      itemId: string;
      feedback?: string;
    },
  ) => unwrap(client.api.loops({ id }).review.post(body)),
  deleteLoop: (id: string) => unwrap(client.api.loops({ id }).delete()),
  activateLoop: (id: string) => unwrap(client.api.loops({ id }).activate.post()),
  deactivateLoop: (id: string) => unwrap(client.api.loops({ id }).deactivate.post()),
  addLoopItem: (loopId: string, body: { source: string; summary: string; priority?: number }) =>
    unwrap(client.api.loops({ id: loopId }).items.post(body)),
  refineLoop: (id: string, body: { intent: string; clarifyRound?: number }) =>
    unwrap(client.api.loops({ id }).refine.post(body)),
  // Work Today
  getWorkToday: () => unwrap(client.api.work.today.get()),
  // Skill packs
  listSkillPacks: () => unwrap(client.api["skill-packs"].get()),
  getSkillPackSkills: (id: string) => unwrap(client.api["skill-packs"]({ id }).skills.get()),
  getSkillPackFiles: (id: string, path?: string) =>
    unwrap(client.api["skill-packs"]({ id }).files.get({ query: path ? { path } : undefined })),
  installSkillPackGit: (body: { name: string; description: string; url: string; ref?: string }) =>
    unwrap(client.api["skill-packs"].git.post(body)),
  uploadSkillPackZip: (body: { name: string; description: string; file: File }) =>
    unwrap(client.api["skill-packs"].upload.post(body)),
  syncSkillPack: (id: string) => unwrap(client.api["skill-packs"]({ id }).sync.post()),
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
  // MCP catalog (ADR 0022, direct fetch - global routes)
  listMcpServers: () =>
    fetch("/api/bff/mcp-servers", { credentials: "include" }).then((r) => r.json()),
  createMcpServer: (body: {
    name: string;
    transport: "stdio" | "sse";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
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
      url?: string;
    },
  ) =>
    fetch(`/api/bff/mcp-servers/${serverId}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  deleteMcpServer: (serverId: string) =>
    fetch(`/api/bff/mcp-servers/${serverId}`, {
      method: "DELETE",
      credentials: "include",
    }).then((r) => r.ok),
  // Knowledge packs (ADR 0022, direct fetch)
  listKnowledgePacks: () =>
    fetch("/api/bff/knowledge-packs", { credentials: "include" }).then((r) => r.json()),
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
  replayFromMessage: async (
    id: string,
    fromSeq: number,
    editedContent: string,
    senderMemberId: string,
    addressedTo: string[],
  ) => {
    const resp = await fetch(`/api/bff/conversations/${id}/replay`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromSeq, editedContent, senderMemberId, addressedTo }),
    });
    return (await resp.json()) as { newConversationId: string };
  },
};
