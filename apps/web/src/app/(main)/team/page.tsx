"use client";

import { AlertCircle, Bot } from "lucide-react";
import Link from "next/link";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useAgentList } from "@/features/agents/hooks";
import { useKnowledgePacks } from "@/features/knowledge/hooks";
import { useMcpCatalog } from "@/features/mcp/hooks";

export default function TeamPage() {
  const { data: agents, isLoading } = useAgentList();
  const { data: mcpData } = useMcpCatalog();
  const { data: knowledgeData } = useKnowledgePacks();

  const active = (agents ?? []).filter((a) => !a.archivedAt);
  const enabled = active.filter((a) => a.enabled !== false).length;
  const disabled = active.length - enabled;

  const unassignedMcp = (mcpData?.mcpServers ?? []).filter(
    (server) =>
      !(agents ?? []).some((a) =>
        a.mcpServers?.some((m) => m.serverId === server.serverId && m.enabled),
      ),
  );
  const unassignedKnowledge = (knowledgeData?.packs ?? []).filter(
    (pack) => !(agents ?? []).some((a) => a.knowledgePacks?.includes(pack.id)),
  );
  const agentsWithoutProjects = active.filter((a) => !a.projects?.length);

  const attentionCount =
    unassignedMcp.length + unassignedKnowledge.length + agentsWithoutProjects.length;

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Team", href: "/team" }, { label: "Overview" }]}
        title="Team"
        description="Your agents and the resources they use."
      />
      <PageBody className="space-y-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-(--hairline) bg-(--canvas-soft) p-4">
            <div className="text-2xl font-semibold text-(--ink) tabular-nums">{active.length}</div>
            <div className="text-xs text-(--mute)">Agents</div>
          </div>
          <div className="rounded-lg border border-(--hairline) bg-(--canvas-soft) p-4">
            <div className="text-2xl font-semibold text-emerald-400 tabular-nums">{enabled}</div>
            <div className="text-xs text-(--mute)">Enabled</div>
          </div>
          <div className="rounded-lg border border-(--hairline) bg-(--canvas-soft) p-4">
            <div className="text-2xl font-semibold text-amber-400 tabular-nums">{disabled}</div>
            <div className="text-xs text-(--mute)">Disabled</div>
          </div>
        </div>

        {attentionCount > 0 && (
          <section className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <AlertCircle className="size-4 text-amber-500" />
              Needs attention
            </h2>
            <div className="space-y-1 text-xs">
              {unassignedMcp.map((s) => (
                <Link
                  key={s.serverId}
                  href="/team/mcp"
                  className="flex justify-between hover:underline"
                >
                  <span className="truncate">{s.name}</span>
                  <span className="shrink-0 text-(--mute)">not assigned</span>
                </Link>
              ))}
              {unassignedKnowledge.map((p) => (
                <Link
                  key={p.id}
                  href="/team/knowledge"
                  className="flex justify-between hover:underline"
                >
                  <span className="truncate">{p.name}</span>
                  <span className="shrink-0 text-(--mute)">not assigned</span>
                </Link>
              ))}
              {agentsWithoutProjects.map((a) => (
                <Link
                  key={a.id}
                  href={`/team/agents/${a.id}`}
                  className="flex justify-between hover:underline"
                >
                  <span className="truncate">{a.name}</span>
                  <span className="shrink-0 text-(--mute)">no projects</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {isLoading ? (
          <div className="space-y-2">
            <div className="h-20 animate-pulse rounded-lg bg-(--panel2)" />
            <div className="h-20 animate-pulse rounded-lg bg-(--panel2)" />
          </div>
        ) : active.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="No agents yet"
            description="Create your first agent to get started."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {active.map((a) => {
              const mcpCount = a.mcpServers?.filter((s) => s.enabled).length ?? 0;
              const knowledgeCount = a.knowledgePacks?.length ?? 0;
              return (
                <Link
                  key={a.id}
                  href={`/team/agents/${a.id}`}
                  className="rounded-lg border border-(--hairline) bg-(--canvas-soft) p-4 hover:border-(--primary) transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-(--ink)">{a.name}</div>
                      <div className="truncate text-xs text-(--mute)">{a.modelName}</div>
                    </div>
                    <Badge variant={a.enabled === false ? "secondary" : "outline"}>
                      {a.enabled === false ? "Disabled" : "Enabled"}
                    </Badge>
                  </div>
                  <div className="mt-3 text-xs text-(--mute)">
                    {mcpCount} MCP · {knowledgeCount} knowledge
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </PageBody>
    </Page>
  );
}
