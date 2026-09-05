"use client";

import { useParams } from "next/navigation";
import { AgentDetail } from "../_components/agent-detail";

export default function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  return <AgentDetail agentId={agentId} />;
}
