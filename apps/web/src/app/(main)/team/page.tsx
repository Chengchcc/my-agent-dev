"use client";

import { AlertCircle, Bot, Boxes, Link2, Plug, Power } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Page, PageBody } from "@/components/page";
import { KpiTile, MonoLabel, PageHeader, StatusPill } from "@/components/patterns";
import { EmptyState } from "@/components/ui/empty-state";
import { useAgentList } from "@/features/agents/hooks";
import { useKnowledgePacks } from "@/features/knowledge/hooks";
import { useMcpCatalog } from "@/features/mcp/hooks";
import { useAgentRuns } from "@/features/ops/hooks";

/** Runtime → left-edge strip / avatar / chip color (design: oma cyan, claude
 * violet, omp emerald, pi red, others faint). */
const RUNTIME_COLOR: Record<string, string> = {
  oma: "var(--primary)",
  claude: "var(--accent-violet)",
  "claude-code": "var(--accent-violet)",
  omp: "var(--ok)",
  pi: "var(--err)",
};

function runtimeColor(kind: string) {
  return RUNTIME_COLOR[kind] ?? "var(--faint)";
}

/** Two-letter avatar initials from the agent display name. */
function initialsOf(name: string) {
  const words = name.split(/\s+/).filter(Boolean);
  const head = words[0]?.[0] ?? "?";
  const tail = words[1]?.[0] ?? "";
  return (head + tail).toUpperCase();
}

type StatusFilter = "all" | "enabled" | "disabled";

const STATUS_OPTIONS: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "Status: All" },
  { id: "enabled", label: "Status: Enabled" },
  { id: "disabled", label: "Status: Disabled" },
];

export default function TeamPage() {
  const { data: agents, isLoading } = useAgentList();
  const { data: runs } = useAgentRuns();
  const { data: mcpData } = useMcpCatalog();
  const { data: knowledgeData } = useKnowledgePacks();
  const [runtimeFilter, setRuntimeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");

  const active = (agents ?? []).filter((a) => !a.archivedAt);
  const enabled = active.filter((a) => a.enabled !== false).length;
  const disabled = active.length - enabled;

  const runtimes = useMemo(
    () => [...new Set(active.map((a) => a.backendKind).filter(Boolean))].sort(),
    [active],
  );

  const boundMcp = active.reduce(
    (sum, a) => sum + (a.mcpServers?.filter((m) => m.enabled).length ?? 0),
    0,
  );
  const boundKnowledge = active.reduce((sum, a) => sum + (a.knowledgePacks?.length ?? 0), 0);

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

  const activeRunAgents = new Set(
    (runs?.runs ?? [])
      .filter((r) => ["running", "waiting", "commit_failed"].includes(r.status))
      .map((r) => r.agentId),
  );

  const visible = active.filter((a) => {
    if (runtimeFilter !== "all" && a.backendKind !== runtimeFilter) return false;
    if (statusFilter === "enabled" && a.enabled === false) return false;
    if (statusFilter === "disabled" && a.enabled !== false) return false;
    if (query && !a.name.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  return (
    <Page>
      <PageHeader
        breadcrumb="Team / Agents matrix"
        title="Team"
        pill={
          active.length > 0 ? (
            <StatusPill tone="success">
              {enabled}/{active.length} alive
            </StatusPill>
          ) : undefined
        }
      />
      <PageBody size="wide" className="space-y-4">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiTile
            label="Active agents"
            value={enabled}
            icon={Bot}
            detail={`${disabled} disabled`}
            bar={active.length === 0 ? 0 : (enabled / active.length) * 100}
            barTone="primary"
          />
          <KpiTile
            label="Runtimes"
            value={runtimes.length}
            icon={Power}
            detail="distinct backends"
          />
          <KpiTile
            label="Bound capabilities"
            value={boundMcp + boundKnowledge}
            icon={Plug}
            detail={`${boundMcp} mcp · ${boundKnowledge} knowledge`}
          />
          <KpiTile
            label="Needs attention"
            value={attentionCount}
            icon={AlertCircle}
            detail="unassigned · no projects"
            bar={attentionCount > 0 ? 100 : 0}
            barTone="violet"
          />
        </div>

        {/* Filter band — runtime chips + status select + name search (all real fields) */}
        <div className="flex flex-col justify-between gap-3 rounded-lg border border-(--hairline) bg-(--panel) px-4 py-2.5 md:flex-row md:items-center">
          <div className="flex flex-wrap items-center gap-1.5">
            <MonoLabel className="mr-1">Filter runtimes:</MonoLabel>
            {[
              { id: "all", label: "All runtimes" },
              ...runtimes.map((r) => ({ id: r, label: r })),
            ].map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setRuntimeFilter(opt.id)}
                className={`rounded px-2 py-0.5 font-mono text-[11px] transition-colors ${
                  runtimeFilter === opt.id
                    ? "bg-(--panel2) font-medium text-(--primary)"
                    : "bg-(--canvas-soft) text-(--mute) hover:text-(--ink)"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-end gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="rounded border border-(--hairline) bg-(--canvas-soft) px-2 py-1 font-mono text-[11px] text-(--mute)"
              aria-label="Filter by status"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter agents…"
              className="w-48 rounded border border-(--hairline) bg-(--canvas-soft) px-2 py-1 font-mono text-[11px] text-(--ink) placeholder:text-(--faint) focus:border-(--primary) focus:outline-none md:w-64"
              aria-label="Search agents by name"
            />
          </div>
        </div>

        {attentionCount > 0 && (
          <section className="rounded-lg border border-(--hairline) bg-(--panel) p-4">
            <div className="mb-2 flex items-center justify-between">
              <MonoLabel className="flex items-center gap-2">
                <AlertCircle className="size-3.5 text-(--warn)" />
                Needs attention
              </MonoLabel>
              <StatusPill tone="waiting">{attentionCount} required</StatusPill>
            </div>
            <div className="divide-y divide-(--hairline) text-xs">
              {unassignedMcp.map((s) => (
                <Link
                  key={s.serverId}
                  href="/team/mcp"
                  className="flex items-center justify-between gap-2 py-2 transition-colors hover:text-(--primary)"
                >
                  <span className="truncate text-(--ink)">{s.name}</span>
                  <MonoLabel>mcp · unassigned</MonoLabel>
                </Link>
              ))}
              {unassignedKnowledge.map((p) => (
                <Link
                  key={p.id}
                  href="/team/knowledge"
                  className="flex items-center justify-between gap-2 py-2 transition-colors hover:text-(--primary)"
                >
                  <span className="truncate text-(--ink)">{p.name}</span>
                  <MonoLabel>knowledge · unassigned</MonoLabel>
                </Link>
              ))}
              {agentsWithoutProjects.map((a) => (
                <Link
                  key={a.id}
                  href={`/team/${a.id}`}
                  className="flex items-center justify-between gap-2 py-2 transition-colors hover:text-(--primary)"
                >
                  <span className="truncate text-(--ink)">{a.name}</span>
                  <MonoLabel>no projects</MonoLabel>
                </Link>
              ))}
            </div>
          </section>
        )}

        {isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <div className="h-44 animate-pulse rounded-lg bg-(--panel2)" />
            <div className="h-44 animate-pulse rounded-lg bg-(--panel2)" />
            <div className="h-44 animate-pulse rounded-lg bg-(--panel2)" />
          </div>
        ) : active.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="No agents yet"
            description="Create your first agent to get started."
          />
        ) : visible.length === 0 ? (
          <EmptyState icon={Bot} title="No match" description="Adjust the filters above." />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {visible.map((a) => {
              const color = runtimeColor(a.backendKind);
              const mcpCount = a.mcpServers?.filter((s) => s.enabled).length ?? 0;
              const knowledgeCount = a.knowledgePacks?.length ?? 0;
              const isDisabled = a.enabled === false;
              return (
                <Link
                  key={a.id}
                  href={`/team/${a.id}`}
                  className="relative overflow-hidden rounded-lg border border-(--hairline) bg-(--panel) p-4 transition-colors hover:bg-(--canvas-soft)"
                >
                  <span
                    className="absolute top-0 left-0 h-full w-1"
                    style={{ backgroundColor: color }}
                  />
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        className="flex size-9 shrink-0 items-center justify-center rounded bg-(--panel2) font-display text-sm font-semibold"
                        style={{ color }}
                      >
                        {initialsOf(a.name)}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-display text-sm font-semibold text-(--ink-strong)">
                            {a.name}
                          </span>
                          <span
                            className="shrink-0 rounded bg-(--panel2) px-1.5 py-0.5 font-mono text-[10px] font-medium"
                            style={{ color }}
                          >
                            {a.backendKind}
                          </span>
                        </div>
                        <span className="block truncate font-mono text-[10px] text-(--mute)">
                          {a.id}
                        </span>
                      </div>
                    </div>
                    <StatusPill
                      tone={isDisabled ? "idle" : activeRunAgents.has(a.id) ? "running" : "success"}
                      className="shrink-0"
                    >
                      {isDisabled ? "idle" : activeRunAgents.has(a.id) ? "running" : "enabled"}
                    </StatusPill>
                  </div>

                  <dl className="mt-3 space-y-1 rounded bg-(--canvas) p-2.5 font-mono text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-(--mute)">Model:</dt>
                      <dd className="truncate font-medium text-(--ink)">{a.modelName}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-(--mute)">Runtime:</dt>
                      <dd className="font-medium" style={{ color }}>
                        {a.backendKind}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-(--mute)">Bindings:</dt>
                      <dd className="font-medium text-(--ink)">
                        {mcpCount} mcp · {knowledgeCount} knowledge
                      </dd>
                    </div>
                  </dl>

                  {(a.projects?.length ?? 0) > 0 && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <MonoLabel className="text-(--faint)">Bound context:</MonoLabel>
                      {a.projects?.slice(0, 3).map((p) => (
                        <span
                          key={p}
                          className="rounded bg-(--canvas-soft) px-1.5 py-0.5 font-mono text-[10px] text-(--accent-violet)"
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 flex items-center justify-between border-t border-(--hairline) pt-2">
                    <span className="flex items-center gap-1.5 font-mono text-[10px] text-(--mute)">
                      <Link2 className="size-3 text-(--ok)" />
                      {a.projects?.length ?? 0} projects
                    </span>
                    <span className="font-mono text-[10px] text-(--faint)">
                      {a.id.slice(0, 10)}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-2 text-xs text-(--faint)">
          <Boxes className="size-3.5" />
          Agent capabilities live in Skills, MCP and Knowledge under Team.
        </div>
      </PageBody>
    </Page>
  );
}
