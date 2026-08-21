import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  agentRunDetailQuery,
  agentRunsQuery,
  agentRuntimeQuery,
  surfacesQuery,
  telemetrySummaryQuery,
} from "./queries";
import { opsKeys } from "./query-keys";

export function useAgentRuns(params?: Parameters<typeof api.listAgentRuns>[0]) {
  return useQuery(agentRunsQuery(params));
}

export function useRunningAgentRuns() {
  return useQuery({
    ...agentRunsQuery({ status: "running", limit: 200 }),
    refetchInterval: 5_000,
  });
}

export function useTelemetrySummary() {
  return useQuery(telemetrySummaryQuery());
}

export function useAgentRunDetail(runId: string) {
  return useQuery(agentRunDetailQuery(runId));
}

export function useAgentRuntime(agentId: string) {
  return useQuery(agentRuntimeQuery(agentId));
}

export function useSurfaces() {
  return useQuery(surfacesQuery());
}

export function useUsageSummary(scope: { conversationId?: string; agentId?: string }) {
  return useQuery({
    queryKey: opsKeys.usageSummary(scope),
    queryFn: () => api.getUsageSummary(scope),
    refetchInterval: 15_000,
  });
}

export function useAgentRuntimes(agentIds: string[], opts?: { refetchInterval?: number }) {
  return useQueries({
    queries: agentIds.map((id) => ({
      queryKey: opsKeys.agentRuntime(id),
      queryFn: () => api.getAgentRuntime(id),
      refetchInterval: opts?.refetchInterval,
    })),
  });
}

export function useCancelAgentRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.cancelAgentRun(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: opsKeys.runs() });
      qc.invalidateQueries({ queryKey: opsKeys.all });
    },
  });
}

export { opsKeys } from "./query-keys";
