"use client";

import { useState } from "react";
import { AgentForm } from "@/components/AgentForm";
import { AgentMemoryPanel } from "@/components/AgentMemoryPanel";
import { ConversationList } from "@/components/ConversationList";
import { IdentityPanel } from "@/components/IdentityPanel";
import { KnowledgePackPanel } from "@/components/KnowledgePackPanel";
import { McpServerPanel } from "@/components/McpServerPanel";
import { AgentRunsTable } from "@/components/ops/AgentRunsTable";
import { QueryState } from "@/components/ops/QueryState";
import { Page, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { SubTabs } from "@/components/ui/polish";
import { WorkspaceExplorer } from "@/components/WorkspaceExplorer";
import { useAgentDetail } from "@/features/agents/hooks";
import { useAgentRuns } from "@/features/ops/hooks";
import { useAgentSkillPacks } from "@/features/skill-packs/hooks";
import { overlineClass } from "@/lib/form-styles";
import { AgentConfigBar } from "./agent-config-bar";
import { AgentDescriptionCard } from "./agent-description-card";
import { AgentProjectsPanel } from "./agent-projects-panel.js";

type Tab =
  | "persona"
  | "skills"
  | "mcp"
  | "knowledge"
  | "projects"
  | "memory"
  | "workspace"
  | "activity";

const TABS: { key: Tab; label: string }[] = [
  { key: "persona", label: "Persona" },
  { key: "skills", label: "Skills" },
  { key: "mcp", label: "MCP" },
  { key: "knowledge", label: "Knowledge" },
  { key: "projects", label: "Projects" },
  { key: "memory", label: "Memory" },
  { key: "workspace", label: "Workspace" },
  { key: "activity", label: "Activity" },
];

type PackStatus = "pending" | "installing" | "ready" | "failed" | "syncing";

function packStatusVariant(
  status: PackStatus,
): "default" | "destructive" | "secondary" | "outline" {
  if (status === "ready") return "default";
  if (status === "failed") return "destructive";
  if (status === "installing" || status === "syncing") return "secondary";
  return "outline";
}

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

  if (isLoading) {
    return (
      <Page>
        <PageHeader breadcrumb="Team / Agents" title="Agent" />
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
        <PageHeader breadcrumb="Team / Agents" title="Agent" />
        <div className="px-4 sm:px-6 lg:px-8 py-6">
          <p className="text-(--text-body) text-(--mute)">Agent not found</p>
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        breadcrumb="Team / Agents"
        title={agent.name}
        action={<AgentForm editAgent={agent} triggerLabel="Edit" />}
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
          {tab === "memory" && <AgentMemoryPanel agentId={agentId} />}
          {tab === "workspace" && <WorkspaceExplorer agentId={agentId} />}
          {tab === "activity" && (
            <div className="space-y-6">
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
  const packsQuery = useAgentSkillPacks(agentId);
  return (
    <QueryState
      query={packsQuery}
      empty={(data) => !data || data.length === 0}
      emptyMessage="No skill packs bound to this agent."
    >
      {(packs) => (
        <ul className="space-y-2">
          {packs.map((p) => {
            const pack = p as {
              id: string;
              name: string;
              description?: string;
              status: PackStatus;
              error?: string;
            };
            return (
              <li
                key={pack.id}
                className="flex items-center justify-between gap-3 rounded border border-(--hairline) px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-(--text-body) font-medium text-(--ink)">
                    {pack.name}
                  </div>
                  {pack.description && (
                    <div className="truncate text-(--text-cap) text-(--mute)">
                      {pack.description}
                    </div>
                  )}
                  {pack.status === "failed" && pack.error && (
                    <div className="truncate text-(--text-cap) text-(--err)">{pack.error}</div>
                  )}
                </div>
                <Badge variant={packStatusVariant(pack.status)} className="shrink-0 text-xs">
                  {packStatusLabel(pack.status)}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </QueryState>
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
              }))}
              onCancel={() => {}}
            />
          </div>
        )}
      </QueryState>
    </div>
  );
}
