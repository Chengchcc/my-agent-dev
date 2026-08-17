"use client";

import { useParams } from "next/navigation";
import { TeamView } from "../../_components/team-view";

export default function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  return <TeamView selectedId={agentId} />;
}
