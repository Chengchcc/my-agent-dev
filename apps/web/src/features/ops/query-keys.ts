export const opsKeys = {
  all: ["ops"] as const,
  runs: (params?: { status?: string; limit?: number }) =>
    ["ops", "agent-runs", params ?? {}] as const,
  runDetail: (runId: string) => ["ops", "agent-runs", runId] as const,
  agentRuntime: (agentId: string) => ["ops", "agents", agentId, "runtime"] as const,
  surfaces: () => ["ops", "surfaces"] as const,
  telemetrySummary: () => ["telemetry-summary"] as const,
  usageSummary: (scope: { conversationId?: string; agentId?: string }) =>
    [
      "ops",
      "usage-summary",
      scope.conversationId ? `conv:${scope.conversationId}` : "",
      scope.agentId ? `agent:${scope.agentId}` : "",
    ] as const,
};
