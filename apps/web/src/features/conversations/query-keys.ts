export const conversationKeys = {
  all: ["conversations"] as const,
  byAgent: (agentId: string) => [...conversationKeys.all, agentId] as const,
  recent: () => [...conversationKeys.all, "recent"] as const,
  detail: (id: string) => ["conv", id] as const,
  search: (q: string) => [...conversationKeys.all, "search", q] as const,
  inputs: (id: string) => ["conversation-inputs", id] as const,
  goal: (id: string) => ["goal", id] as const,
};
