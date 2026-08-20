"use client";

import { MemoryPanel } from "@/components/MemoryPanel";

export function AgentMemoryPanel({ agentId }: { agentId: string }) {
  return <MemoryPanel agentId={agentId} />;
}
