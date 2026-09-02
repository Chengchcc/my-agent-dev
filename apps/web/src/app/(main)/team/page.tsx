"use client";

import { Bot } from "lucide-react";
import Link from "next/link";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useAgentList } from "@/features/agents/hooks";

export default function TeamPage() {
  const { data: agents, isLoading } = useAgentList();

  const active = (agents ?? []).filter((a) => !a.archivedAt);
  const enabled = active.filter((a) => a.enabled !== false).length;
  const disabled = active.length - enabled;

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
