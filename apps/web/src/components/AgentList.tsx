"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAgentList, useArchiveAgent } from "@/features/agents/hooks";
import { useAgentRuntimes } from "@/features/ops/hooks";
import type { AgentRuntimeStatus } from "@/lib/api";

/** Derive a dot color + label from an agent's runtime surface health.
 *  `loading` separates the query-in-flight state from a genuinely absent
 *  runtime — "Unknown" must never be the rendering of a pending request. */
function runtimeBadge(
  rt: AgentRuntimeStatus | undefined,
  loading: boolean,
): { color: string; label: string; lastSeenAt: number | null } {
  if (loading) return { color: "bg-[var(--mute)]", label: "Loading", lastSeenAt: null };
  if (!rt) return { color: "bg-[var(--mute)]", label: "No surface data", lastSeenAt: null };
  const surfaces = Object.values(rt.surfaces);
  if (surfaces.length === 0)
    return { color: "bg-[var(--primary)]", label: "Idle", lastSeenAt: null };
  const hasError = surfaces.some((s) => s.status !== "running" || s.lastError);
  const lastSeenAt = surfaces.reduce<number | null>((max, s) => {
    if (s.lastSeenAt == null) return max;
    return max == null || s.lastSeenAt > max ? s.lastSeenAt : max;
  }, null);
  if (hasError) return { color: "bg-[var(--chart-5)]", label: "Error", lastSeenAt };
  return { color: "bg-[var(--primary)]", label: "Ready", lastSeenAt };
}

function ago(ts: number | null): string {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function AgentList() {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const { data: agents, isLoading } = useAgentList();
  const archive = useArchiveAgent();

  const active = (agents ?? []).filter((a) => !a.archivedAt);
  const agentIds = active.map((a) => a.id);
  // ponytail: refetch every 15s keeps the dot fresh without a websocket.
  const runtimeQueries = useAgentRuntimes(agentIds, { refetchInterval: 15_000 });
  const runtimeById = useMemo(() => {
    const m = new Map<string, AgentRuntimeStatus>();
    for (const q of runtimeQueries) {
      if (q.data) m.set(q.data.agentId, q.data);
    }
    return m;
  }, [runtimeQueries]);
  function handleArchive(id: string) {
    setConfirmingId(id);
    archive.mutate(id, {
      onSuccess: () => {
        toast.success("Agent archived");
        setConfirmingId(null);
      },
      onError: (err) => {
        toast.error("Failed to archive agent", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      },
    });
  }

  if (isLoading) {
    return (
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="border border-[var(--hairline)] rounded-lg bg-[var(--canvas)] p-8 animate-pulse"
          >
            <div className="h-5 w-32 bg-[var(--canvas-soft)] mb-3" />
            <div className="h-4 w-24 bg-[var(--canvas-soft)]" />
          </div>
        ))}
      </div>
    );
  }

  if (active.length === 0) {
    return (
      <div className="py-24 text-center">
        <p className="text-lg text-[var(--mute)] mb-2 font-[family-name:var(--font-sans)]">
          No agents yet
        </p>
        <p className="text-sm text-[var(--mute)]">Create your first agent to begin.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {active.map((agent) => (
        <div key={agent.id} className="relative group">
          <Link
            href={`/team/${agent.id}`}
            className="block border border-[var(--hairline)] rounded-lg bg-[var(--canvas)] p-8
                       hover:border-[var(--primary)] transition-colors duration-300
                       "
            style={{}}
          >
            <h3
              className="text-xl font-normal text-[var(--ink-strong)] tracking-tight font-[family-name:var(--font-sans)]"
              style={{ letterSpacing: "-0.65px" }}
            >
              {agent.name}
            </h3>

            <div className="mt-3 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--primary)] opacity-60" />
              <span
                className="text-xs text-[var(--mute)] tracking-wider uppercase font-[family-name:var(--font-sans)] font-semibold"
                style={{ letterSpacing: "2.52px" }}
              >
                {agent.modelProvider}/{agent.modelName}
              </span>
            </div>

            <div className="mt-3 flex items-center gap-2">
              {(() => {
                const q = runtimeQueries.find((r) => r.data?.agentId === agent.id);
                const badge = runtimeBadge(runtimeById.get(agent.id), !!q?.isLoading && !q?.data);
                return (
                  <>
                    <span className={`w-1.5 h-1.5 rounded-full ${badge.color}`} />
                    <span className="text-[10px] text-[var(--mute)] tracking-wider uppercase font-[family-name:var(--font-sans)] font-semibold">
                      {badge.label}
                      {ago(badge.lastSeenAt) ? ` · ${ago(badge.lastSeenAt)}` : ""}
                    </span>
                  </>
                );
              })()}
            </div>

            <div className="mt-4 flex items-center gap-3 text-[10px] text-[var(--mute)]">
              <span className="border border-[var(--hairline)] rounded-sm px-1.5 py-0.5 uppercase tracking-[0.15em] font-[family-name:var(--font-sans)] font-semibold">
                {agent.permissionMode}
              </span>
              <span>
                {new Date(agent.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </div>
          </Link>

          {/* Delete / archive controls */}
          {confirmingId === agent.id ? (
            <div className="absolute top-3 right-3 flex gap-1">
              <Button
                size="xs"
                variant="secondary"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleArchive(agent.id);
                }}
                disabled={archive.isPending}
              >
                Confirm
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setConfirmingId(null);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="xs"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setConfirmingId(agent.id);
              }}
              className="absolute top-3 right-3 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
            >
              Archive
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
