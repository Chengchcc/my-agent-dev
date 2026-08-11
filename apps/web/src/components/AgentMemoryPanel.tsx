"use client";

import { useQuery } from "@tanstack/react-query";
import { MemoryPanel } from "@/components/MemoryPanel";
import { api } from "@/lib/api";

export function AgentMemoryPanel({ agentId }: { agentId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["agent-memory", agentId],
    queryFn: () => api.getAgentMemory(agentId),
  });

  if (isLoading) return <div className="text-sm text-(--mute)">Loading memories...</div>;
  return <MemoryPanel memory={data} />;
}
