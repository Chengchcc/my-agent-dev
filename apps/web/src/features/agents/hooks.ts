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
  catalog: ["mcp-catalog"] as const,
};

export function useMcpCatalog() {
  return useQuery({
    queryKey: mcpKeys.catalog,
    queryFn: () => api.listMcpServers(),
  });
}

export function useCreateMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createMcpServer>[0]) => api.createMcpServer(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpKeys.catalog }),
  });
}

export function useUpdateMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      serverId,
      ...body
    }: { serverId: string } & Parameters<typeof api.updateMcpServer>[1]) =>
      api.updateMcpServer(serverId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpKeys.catalog }),
  });
}

export function useDeleteMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (serverId: string) => api.deleteMcpServer(serverId),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpKeys.catalog }),
  });
}
