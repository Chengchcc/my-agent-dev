import { queryOptions } from "@tanstack/react-query";
import { type AgentMemory, api } from "@/lib/api";
import { agentKeys } from "./query-keys";

export function agentListQuery(filters?: Record<string, unknown>) {
  return queryOptions({
    queryKey: agentKeys.list(filters),
    queryFn: api.listAgents,
  });
}

export function agentDetailQuery(id: string) {
  return queryOptions({
    queryKey: agentKeys.detail(id),
    queryFn: () => api.getAgent(id),
  });
}

export function agentIdentityQuery(id: string) {
  return queryOptions({
    queryKey: agentKeys.identity(id),
    queryFn: () => api.getIdentity(id),
  });
}

export function agentMemoryQuery(id: string) {
  return queryOptions({
    queryKey: agentKeys.memory(id),
    queryFn: () => api.getAgentMemory(id) as Promise<AgentMemory>,
  });
}
