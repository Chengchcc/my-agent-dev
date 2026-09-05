export const agentKeys = {
  all: ["agents"] as const,
  lists: () => [...agentKeys.all, "list"] as const,
  list: (filters?: Record<string, unknown>) => [...agentKeys.lists(), filters ?? {}] as const,
  details: () => [...agentKeys.all, "detail"] as const,
  detail: (id: string) => [...agentKeys.details(), id] as const,
  identity: (id: string) => [...agentKeys.all, "identity", id] as const,
  memory: (id: string) => [...agentKeys.all, "memory", id] as const,
  workspace: (id: string, path: string) => [...agentKeys.all, "workspace", id, path] as const,
};
