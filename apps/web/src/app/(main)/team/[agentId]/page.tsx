"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { AgentForm } from "@/components/AgentForm";
import { AgentMemoryPanel } from "@/components/AgentMemoryPanel";
import { ConversationList } from "@/components/ConversationList";
import { IdentityPanel } from "@/components/IdentityPanel";
import { McpServerPanel } from "@/components/McpServerPanel";
import { AgentRunsTable } from "@/components/ops/AgentRunsTable";
import { QueryState } from "@/components/ops/QueryState";
import { Page, PageBody, PageHeader } from "@/components/page";
import { RelationshipPanel } from "@/components/RelationshipPanel";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAgentDetail, useAgentList, useAgentRelationships } from "@/features/agents/hooks";
import { useAgentRuns } from "@/features/ops/hooks";
import { useAgentSkillPacks } from "@/features/skill-packs/hooks";
import { overlineClass } from "@/lib/form-styles";

type Tab = "persona" | "skills" | "activity" | "mcp" | "relationships" | "memory";

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
      <Page>
        <PageBody>
          <div className="animate-pulse space-y-3">
            <div className="h-6 w-48 bg-(--canvas-soft)" />
            <div className="h-4 w-32 bg-(--canvas-soft)" />
          </div>
        </PageBody>
      </Page>
    );
  }

  if (!agent) {
    return (
      <Page>
        <PageBody>
          <p className="text-sm text-(--mute)">Agent not found</p>
        </PageBody>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        breadcrumb="Team / Agents"
        title={agent.name}
        action={
          <div className="flex items-center gap-2">
            <span className={`${overlineClass} border border-(--hairline) rounded px-2 py-0.5`}>
              {agent.modelProvider}/{agent.modelName}
            </span>
            <span className={`${overlineClass} border border-(--hairline) rounded px-2 py-0.5`}>
              {agent.permissionMode}
            </span>
            <AgentForm editAgent={agent} triggerLabel="Edit" />
          </div>
        }
      />
      <PageBody>
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList
            variant="line"
            className="w-full justify-start overflow-x-auto whitespace-nowrap"
          >
            <TabsTrigger value="persona">Persona</TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="mcp">MCP</TabsTrigger>
            <TabsTrigger value="relationships">Relationships</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
          </TabsList>
          <TabsContent value="persona" className="w-full min-w-0 pt-4">
            <IdentityPanel agentId={id} />
          </TabsContent>
          <TabsContent value="skills" className="w-full min-w-0 pt-4">
            <AgentSkillsPanel agentId={id} />
          </TabsContent>
          <TabsContent value="activity" className="w-full min-w-0 pt-4">
            <div className="space-y-6">
              <ConversationList agentId={id} agentName={agent?.name} />
              <RecentRuns agentId={id} />
            </div>
          </TabsContent>
          <TabsContent value="mcp" className="w-full min-w-0 pt-4">
            <McpServerPanel agentId={id} />
          </TabsContent>
          <TabsContent value="relationships" className="w-full min-w-0 pt-4">
            <AgentRelationshipsPanel agentId={id} />
          </TabsContent>
          <TabsContent value="memory" className="w-full min-w-0 pt-4">
            <AgentMemoryPanel agentId={id} />
          </TabsContent>
        </Tabs>
      </PageBody>
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
                className="flex items-center justify-between gap-3 border border-(--hairline) rounded px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="text-sm text-(--ink) font-medium truncate">{pack.name}</div>
                  {pack.description && (
                    <div className="text-xs text-(--mute) truncate">{pack.description}</div>
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
