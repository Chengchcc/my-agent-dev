"use client";

import { MessageCircle, Package } from "lucide-react";
import { useState } from "react";

import { AgentForm } from "@/components/AgentForm";
import { AgentMemoryPanel } from "@/components/AgentMemoryPanel";
import { ConversationList } from "@/components/ConversationList";
import { IdentityPanel } from "@/components/IdentityPanel";
import { KnowledgePackPanel } from "@/components/KnowledgePackPanel";
import { LarkBotPanel } from "@/components/LarkBotPanel";
import { McpServerPanel } from "@/components/McpServerPanel";
import { AgentRunsTable } from "@/components/ops/AgentRunsTable";
import { QueryState } from "@/components/ops/QueryState";
import { Page, PageHeader } from "@/components/page";
import { UsagePanel } from "@/components/UsagePanel";
import { Button } from "@/components/ui/button";
import { ListRowCard, SubTabs } from "@/components/ui/polish";
import { Switch } from "@/components/ui/switch";
import { WorkspaceExplorer } from "@/components/WorkspaceExplorer";
import { useAgentDetail } from "@/features/agents/hooks";
import { useStartChat } from "@/features/conversations/hooks";
import { useAgentRuns } from "@/features/ops/hooks";
import {
  useAgentSkillPacks,
  useSetAgentPacks,
  useSkillPackList,
} from "@/features/skill-packs/hooks";
import { overlineClass } from "@/lib/form-styles";
import { AgentConfigBar } from "./agent-config-bar";
import { AgentDescriptionCard } from "./agent-description-card";
import { AgentProjectsPanel } from "./agent-projects-panel";

type Tab =
  | "persona"
  | "skills"
  | "mcp"
  | "knowledge"
  | "projects"
  | "lark"
  | "memory"
  | "workspace"
  | "activity";

const TABS: { key: Tab; label: string }[] = [
  { key: "persona", label: "Persona" },
  { key: "skills", label: "Skills" },
  { key: "mcp", label: "MCP" },
  { key: "knowledge", label: "Knowledge" },
  { key: "projects", label: "Projects" },
  { key: "lark", label: "Lark" },
  { key: "memory", label: "Memory" },
  { key: "workspace", label: "Workspace" },
  { key: "activity", label: "Activity" },
];

type PackStatus = "pending" | "installing" | "ready" | "failed" | "syncing";

function packStatusLabel(status: PackStatus): string {
  if (status === "pending") return "Pending";
  if (status === "installing") return "Installing…";
  if (status === "syncing") return "Syncing…";
  if (status === "ready") return "Ready";
  if (status === "failed") return "Failed";
  return status;
}

/** Column 3 of the master-detail split: agent header + description card +
 *  inline config bar + the seven-tab content area. Content per tab is the
 *  existing real panels, only the tab shell moved to SubTabs. */
export function AgentDetail({ agentId }: { agentId: string }) {
  const [tab, setTab] = useState<Tab>("persona");
  const { data: agent, isLoading } = useAgentDetail(agentId);
  const chat = useStartChat(agentId, agent?.name);

  if (isLoading) {
    return (
      <Page>
        <PageHeader
          breadcrumb={[{ label: "Team", href: "/team" }, { label: "Agents" }]}
          title="Agent"
        />
        <div className="animate-pulse space-y-3 px-4 sm:px-6 lg:px-8 py-6">
          <div className="h-6 w-48 bg-(--panel2)" />
          <div className="h-4 w-32 bg-(--panel2)" />
        </div>
      </Page>
    );
  }

  if (!agent) {
    return (
      <Page>
        <PageHeader
          breadcrumb={[{ label: "Team", href: "/team" }, { label: "Agents" }]}
          title="Agent"
        />
        <div className="px-4 sm:px-6 lg:px-8 py-6">
          <p className="text-(--text-body) text-(--mute)">Agent not found</p>
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Team", href: "/team" }, { label: "Agents" }]}
        title={agent.name}
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => chat.start()} disabled={chat.isPending}>
              <MessageCircle className="size-4" />
              Chat
            </Button>
            <AgentForm editAgent={agent} triggerLabel="Edit" />
          </div>
        }
      />
      <div className="mx-auto max-w-[860px] space-y-6 px-4 sm:px-6 lg:px-8 py-6">
        <AgentDescriptionCard agent={agent} />
        <AgentConfigBar agent={agent} />
        <SubTabs items={TABS} active={tab} onChange={(k) => setTab(k as Tab)} />
        <div className="pt-2">
          {tab === "persona" && <IdentityPanel agentId={agentId} />}
          {tab === "skills" && <AgentSkillsPanel agentId={agentId} />}
          {tab === "mcp" && <McpServerPanel agentId={agentId} />}
          {tab === "knowledge" && <KnowledgePackPanel agentId={agentId} />}
          {tab === "projects" && <AgentProjectsPanel agent={agent} />}
          {tab === "lark" && <LarkBotPanel agentId={agentId} />}
          {tab === "memory" && <AgentMemoryPanel agentId={agentId} />}
          {tab === "workspace" && <WorkspaceExplorer agentId={agentId} />}
          {tab === "activity" && (
            <div className="space-y-6">
              <div className="rounded-lg border border-(--hairline) px-3 pb-1 pt-3">
                <UsagePanel agentId={agentId} />
              </div>
              <ConversationList agentId={agentId} agentName={agent.name} />
              <RecentRuns agentId={agentId} />
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}
function AgentSkillsPanel({ agentId }: { agentId: string }) {
  const { data: allPacks } = useSkillPackList();
  const { data: assigned } = useAgentSkillPacks(agentId);
  const setPacks = useSetAgentPacks(agentId);
  const packs = (allPacks ?? []) as Array<{
    id: string;
    name: string;
    description?: string;
    status: PackStatus;
    error?: string;
  }>;
  const assignedIds = new Set((assigned ?? []).map((p) => p.id));

  if (packs.length === 0) {
    return (
      <p className="text-sm text-(--mute)">
        No skill packs installed — add them on the Skill Packs page.
      </p>
    );
  }

  const toggle = (packId: string, on: boolean) => {
    const next = new Set(assignedIds);
    if (on) next.add(packId);
    else next.delete(packId);
    setPacks.mutate([...next]);
  };

  return (
    <div className="space-y-2">
      {packs.map((pack) => (
        <ListRowCard
          key={pack.id}
          icon={<Package className="size-4 text-(--mute)" />}
          title={pack.name}
          badges={[packStatusLabel(pack.status)]}
          meta={
            pack.status === "ready" && !assignedIds.has(pack.id)
              ? ["available (not assigned)"]
              : undefined
          }
          status={pack.status === "ready" ? "ok" : pack.status === "failed" ? "err" : undefined}
          actions={
            <Switch
              checked={assignedIds.has(pack.id)}
              disabled={pack.status !== "ready"}
              onCheckedChange={(on) => void toggle(pack.id, on === true)}
            />
          }
        />
      ))}
    </div>
  );
}

function RecentRuns({ agentId }: { agentId: string }) {
  const runsQuery = useAgentRuns({ agentId, limit: 50 });
  return (
    <div>
      <h2 className={`${overlineClass} mb-3`}>Recent Runs</h2>
      <QueryState
        query={runsQuery}
        empty={(data) => data.runs.length === 0}
        emptyMessage="No recent runs."
      >
        {(data) => (
          <div className="rounded-lg border border-(--hairline)">
            <AgentRunsTable
              runs={data.runs.map((r) => ({
                runId: r.runId,
                status: r.status,
                agentId: r.agentId ?? "",
                model: r.model.modelId,
                createdAt: r.createdAt,
                terminalAt: r.terminalAt,
                usage: r.usage ?? null,
                error: r.error ?? null,
              }))}
              onCancel={() => {}}
            />
          </div>
        )}
      </QueryState>
    </div>
  );
}
