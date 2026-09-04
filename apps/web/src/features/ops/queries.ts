import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { opsKeys } from "./query-keys";

export function agentRunsQuery(params?: Parameters<typeof api.listAgentRuns>[0]) {
  return queryOptions({
    queryKey: opsKeys.runs(params),
    queryFn: () => api.listAgentRuns(params),
  });
}

export function agentRunDetailQuery(runId: string) {
  return queryOptions({
    queryKey: opsKeys.runDetail(runId),
    queryFn: () => api.getAgentRun(runId),
  });
}

export function agentRuntimeQuery(agentId: string) {
  return queryOptions({
    queryKey: opsKeys.agentRuntime(agentId),
    queryFn: () => api.getAgentRuntime(agentId),
  });
}

export function surfacesQuery() {
  return queryOptions({
    queryKey: opsKeys.surfaces(),
    queryFn: () => api.listSurfaces(),
  });
}

export function telemetrySummaryQuery() {
  return queryOptions({
    queryKey: opsKeys.telemetrySummary(),
    queryFn: () => api.getTelemetrySummary(),
  });
}

/** Backend round-trip latency in ms, measured through the BFF. */
export function backendPingQuery() {
  return queryOptions({
    queryKey: opsKeys.backendPing(),
    queryFn: async () => {
      const t0 = performance.now();
      await api.listSurfaces();
      return Math.round(performance.now() - t0);
    },
    refetchInterval: 30_000,
    retry: 1,
  });
}
