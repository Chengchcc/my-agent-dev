"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { AgentForm } from "@/components/AgentForm";
import { AgentMemoryPanel } from "@/components/AgentMemoryPanel";
import { AgentPetPanel } from "@/components/AgentPetPanel";
import { ConversationList } from "@/components/ConversationList";
import { IdentityPanel } from "@/components/IdentityPanel";
import { McpServerPanel } from "@/components/McpServerPanel";
import { AgentRunsTable } from "@/components/ops/AgentRunsTable";
import { QueryState } from "@/components/ops/QueryState";
import { RelationshipPanel } from "@/components/RelationshipPanel";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { useAgentDetail, useAgentList, useAgentRelationships } from "@/features/agents/hooks";
import { useAgentRuns } from "@/features/ops/hooks";
import { useAgentSkillPacks } from "@/features/skill-packs/hooks";

type Tab = "persona" | "skills" | "activity" | "mcp" | "relationships" | "pet" | "memory";

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

export default function AgentDetailPage() {
  const { agentId: id } = useParams<{ agentId: string }>();
  const [tab, setTab] = useState<Tab>("persona");
  const { data: agent, isLoading } = useAgentDetail(id);

  if (isLoading) {
    return (
      <div className="container mx-auto px-8 py-10">
        <div className="animate-pulse space-y-3">
          <div className="h-6 w-48 bg-[var(--canvas-soft)]" />
          <div className="h-4 w-32 bg-[var(--canvas-soft)]" />
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="container mx-auto px-8 py-10">
        <p className="text-sm text-[var(--mute)]">Agent not found</p>
      </div>
    );
  }

  const tabClass = (t: Tab) =>
    `h-auto rounded-none border-0 border-b bg-transparent px-0 pb-3 text-[10px] tracking-[2.52px] uppercase transition-colors duration-300 font-[family-name:var(--font-sans)] font-semibold hover:bg-transparent ${
      tab === t
        ? "border-[var(--primary)] text-[var(--ink)]"
        : "border-transparent text-[var(--mute)] hover:text-[var(--body)]"
    }`;

  return (
    <div className="h-full bg-[var(--canvas)] flex flex-col">
      {/* Header */}
      <div className="border-b border-[var(--hairline)] shrink-0">
        <div className="container mx-auto px-8 py-5">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3 flex-wrap">
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink href="/team">Team</BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{agent.name}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              <span className="text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] border border-[var(--hairline)] rounded px-2 py-0.5 font-[family-name:var(--font-sans)] font-semibold">
                {agent.modelProvider}/{agent.modelName}
              </span>
              <span className="text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] border border-[var(--hairline)] rounded px-2 py-0.5 font-[family-name:var(--font-sans)] font-semibold">
                {agent.permissionMode}
              </span>
            </div>
            <AgentForm editAgent={agent} triggerLabel="Edit" />
          </div>

          {/* Tabs */}
          <div className="flex gap-8 mt-6" role="tablist">
            <Button
              variant="ghost"
              role="tab"
              aria-selected={tab === "persona"}
              className={tabClass("persona")}
              onClick={() => setTab("persona")}
            >
              Persona
            </Button>
            <Button
              variant="ghost"
              role="tab"
              aria-selected={tab === "skills"}
              className={tabClass("skills")}
              onClick={() => setTab("skills")}
            >
              Skills
            </Button>
            <Button
              variant="ghost"
              role="tab"
              aria-selected={tab === "activity"}
              className={tabClass("activity")}
              onClick={() => setTab("activity")}
            >
              Activity
            </Button>
            <Button
              variant="ghost"
              role="tab"
              aria-selected={tab === "mcp"}
              className={tabClass("mcp")}
              onClick={() => setTab("mcp")}
            >
              MCP
            </Button>
            <Button
              variant="ghost"
              role="tab"
              aria-selected={tab === "relationships"}
              className={tabClass("relationships")}
              onClick={() => setTab("relationships")}
            >
              Relationships
            </Button>
            <Button
              variant="ghost"
              role="tab"
              aria-selected={tab === "pet"}
              className={tabClass("pet")}
              onClick={() => setTab("pet")}
            >
              Pet
            </Button>
            <Button
              variant="ghost"
              role="tab"
              aria-selected={tab === "memory"}
              className={tabClass("memory")}
              onClick={() => setTab("memory")}
            >
              Memory
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="container mx-auto px-8 py-10">
          {tab === "persona" && <IdentityPanel agentId={id} />}
          {tab === "skills" && <AgentSkillsPanel agentId={id} />}
          {tab === "activity" && (
            <div className="space-y-6">
              <ConversationList agentId={id} agentName={agent?.name} />
              <RecentRuns agentId={id} />
            </div>
          )}
          {tab === "mcp" && <McpServerPanel agentId={id} />}
          {tab === "relationships" && <AgentRelationshipsPanel agentId={id} />}
          {tab === "pet" && <AgentPetPanel agentId={id} />}
          {tab === "memory" && <AgentMemoryPanel agentId={id} />}
        </div>
      </div>
    </div>
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
                className="flex items-center justify-between gap-3 border border-[var(--hairline)] rounded px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="text-sm text-[var(--ink)] font-medium truncate">{pack.name}</div>
                  {pack.description && (
                    <div className="text-xs text-[var(--mute)] truncate">{pack.description}</div>
                  )}
                  {pack.status === "failed" && pack.error && (
                    <div className="text-xs text-destructive truncate">{pack.error}</div>
                  )}
                </div>
                <Badge variant={packStatusVariant(pack.status)} className="text-xs shrink-0">
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

function AgentRelationshipsPanel({ agentId }: { agentId: string }) {
  const { data: rels } = useAgentRelationships(agentId);
  const { data: allAgents } = useAgentList();
  return (
    <RelationshipPanel
      agentId={agentId}
      relationships={rels?.relationships ?? []}
      agents={allAgents ?? []}
    />
  );
}

function RecentRuns({ agentId }: { agentId: string }) {
  const runsQuery = useAgentRuns({ agentId, limit: 50 });
  return (
    <div>
      <h2 className="text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] font-[family-name:var(--font-sans)] font-semibold mb-3">
        Recent Runs
      </h2>
      <QueryState
        query={runsQuery}
        empty={(data) => data.runs.length === 0}
        emptyMessage="No recent runs."
      >
        {(data) => (
          <div className="rounded-lg border border-[var(--hairline)]">
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
