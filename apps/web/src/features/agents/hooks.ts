import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { agentDetailQuery, agentIdentityQuery, agentListQuery } from "./queries";

export function useAgentList(opts?: { enabled?: boolean }) {
  return useQuery({ ...agentListQuery(), ...opts });
}

export function useAgentDetail(id: string) {
  return useQuery(agentDetailQuery(id));
}

export function useAgentIdentity(id: string) {
  return useQuery(agentIdentityQuery(id));
}

export { useArchiveAgent, useCreateAgent, useSetIdentity, useUpdateAgent } from "./mutations";
export { agentKeys } from "./query-keys";

const mcpKeys = {
  list: (agentId: string) => ["mcp-servers", agentId] as const,
};

export function useAgentMcpServers(agentId: string) {
  return useQuery({
    queryKey: mcpKeys.list(agentId),
    queryFn: () => api.listMcpServers(agentId),
  });
}

export function useCreateMcpServer(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createMcpServer>[1]) =>
      api.createMcpServer(agentId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpKeys.list(agentId) }),
  });
}

export function useUpdateMcpServer(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      serverId,
      ...body
    }: { serverId: string } & Parameters<typeof api.updateMcpServer>[2]) =>
      api.updateMcpServer(agentId, serverId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpKeys.list(agentId) }),
  });
}

export function useDeleteMcpServer(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (serverId: string) => api.deleteMcpServer(agentId, serverId),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpKeys.list(agentId) }),
  });
}
