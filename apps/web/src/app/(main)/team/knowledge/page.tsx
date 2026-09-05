"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  BookOpen as BookOpenIcon,
  CircleAlert,
  CircleCheck,
  Download,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AssignToAgentSelect } from "@/components/AssignToAgentSelect";
import { Page, PageBody, PageHeader } from "@/components/page";
import { KpiTile, MonoLabel, StatusPill, type StatusTone } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InfoBanner, ListToolbar, SectionKicker, statusBadge } from "@/components/ui/polish";
import { ResourceDetailSheet } from "@/components/ui/resource-detail-sheet";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { useAgentList } from "@/features/agents/hooks";
import { agentKeys } from "@/features/agents/query-keys";
import { useKnowledgePacks } from "@/features/knowledge/hooks";
import type { KnowledgePackRow } from "@/features/knowledge/queries";
import { knowledgePackKeys } from "@/features/knowledge/query-keys";
import { type AgentRow, api } from "@/lib/api";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

function packTone(status: string): StatusTone {
  if (status === "ready") return "success";
  if (status === "failed") return "error";
  if (status === "installing" || status === "syncing") return "running";
  return "idle";
}

function statusLabel(status: string): string {
  if (status === "installing") return "installing";
  if (status === "syncing") return "syncing";
  if (status === "pending") return "pending";
  if (status === "ready") return "ready";
  if (status === "failed") return "failed";
  return status;
}

function KnowledgeDetailSheet({
  pack,
  usedBy,
  agents,
  isAssigned,
  onAssign,
  onClose,
}: {
  pack: KnowledgePackRow;
  usedBy: string[];
  agents: AgentRow[];
  isAssigned: (agentId: string) => boolean;
  onAssign: (agentId: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"overview" | "agents">("overview");
  const [stats, setStats] = useState<{
    files: number;
    totalBytes: number;
    estTokens: number;
    newestFileAt: number | null;
  } | null>(null);
  const badge = statusBadge(pack.status);

  useEffect(() => {
    setStats(null);
    api
      .knowledgeStats(pack.id)
      .then((r) => setStats(r as typeof stats))
      .catch(() => setStats(null));
  }, [pack.id]);
  return (
    <ResourceDetailSheet
      open
      onClose={onClose}
      icon={<BookOpen className="size-5 text-(--mute)" />}
      title={pack.name}
      subtitle={pack.sourceKind}
      badge={{
        label: badge.label,
        tone: pack.status === "ready" ? "ok" : pack.status === "failed" ? "err" : "warn",
      }}
      tabs={[
        { key: "overview", label: "Overview" },
        { key: "agents", label: "Agents" },
      ]}
      tab={tab}
      onTabChange={(key) => setTab(key as "overview" | "agents")}
      breadcrumb={[{ label: pack.name }, { label: "Overview" }]}
      footer={
        <>
          <Text as="p" className="mr-auto text-xs text-(--mute)">
            Used by {usedBy.length} agent{usedBy.length > 1 ? "s" : ""}
          </Text>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {tab === "overview" && (
        <div className="space-y-4">
          <Text as="p" className="text-sm text-(--mute)">
            {pack.description || "No description."}
          </Text>
          <dl className="space-y-1 text-sm">
            <DetailRow label="Type" value={pack.sourceKind} />
            <DetailRow label="Source" value={pack.sourceUrl ?? pack.installedRef ?? "—"} />
            <DetailRow label="Status" value={badge.label} />
            <DetailRow label="Source revision" value={pack.sourceRev ?? pack.versionRef ?? "—"} />
            <DetailRow
              label="Indexed"
              value={
                stats
                  ? `${stats.files} files · ${fmtBytes(stats.totalBytes)} · ~${stats.estTokens.toLocaleString()} tokens`
                  : "scanning…"
              }
            />
            <DetailRow label="Installed" value={`${usedBy.length} agents`} />
            <DetailRow label="Updated" value={formatDate(pack.updatedAt)} />
          </dl>
        </div>
      )}
      {tab === "agents" && (
        <div className="space-y-3">
          <AssignToAgentSelect agents={agents} assigned={isAssigned} onAssign={onAssign} />
          {usedBy.length === 0 ? (
            <Text as="p" className="text-sm text-(--mute)">
              Not assigned to any agent yet.
            </Text>
          ) : (
            usedBy.map((name) => (
              <div
                key={name}
                className="flex items-center justify-between rounded-md border border-(--hairline) px-3 py-2"
              >
                <Text as="span" className="text-sm">
                  {name}
                </Text>
                <span className="rounded bg-(--ok)/12 px-1.5 py-0.5 text-xs text-(--ok)">
                  Active
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </ResourceDetailSheet>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Text as="dt" className="text-(--mute)">
        {label}
      </Text>
      <Text as="dd" className="truncate text-right">
        {value}
      </Text>
    </div>
  );
}

function formatDate(value: number): string {
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toLocaleDateString();
}

export default function KnowledgePackPage() {
  const qc = useQueryClient();
  const { data, refetch } = useKnowledgePacks();
  const { data: agentsData } = useAgentList();
  const [allStats, setAllStats] = useState<Record<string, { files: number; totalBytes: number }>>(
    {},
  );
  useEffect(() => {
    api
      .knowledgeAllStats()
      .then((rows) => {
        const map: Record<string, { files: number; totalBytes: number }> = {};
        for (const r of rows) {
          map[r.packId] = { files: r.files, totalBytes: r.totalBytes };
        }
        setAllStats(map);
      })
      .catch(() => {});
  }, []);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceKind, setSourceKind] = useState<"builtin" | "git">("git");
  const [sourceUrl, setSourceUrl] = useState("");
  const [confirmPackId, setConfirmPackId] = useState<string | null>(null);
  const [showInstall, setShowInstall] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const install = useMutation({
    mutationFn: () => {
      const body: {
        name: string;
        description?: string;
        sourceKind: "builtin" | "git";
        sourceUrl?: string;
      } = { name, sourceKind };
      if (description) body.description = description;
      if (sourceKind === "git") body.sourceUrl = sourceUrl;
      return api.installKnowledgePack(body);
    },
    onSuccess: () => {
      setName("");
      setDescription("");
      setSourceUrl("");
      setShowInstall(false);
      void qc.invalidateQueries({ queryKey: knowledgePackKeys.all });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteKnowledgePack(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: knowledgePackKeys.all }),
  });

  const packs = useMemo(() => data?.packs ?? [], [data]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return packs.filter((p) => {
      if (statusFilter === "ready" && p.status !== "ready") return false;
      if (
        statusFilter === "syncing" &&
        p.status !== "syncing" &&
        p.status !== "installing" &&
        p.status !== "pending"
      )
        return false;
      if (statusFilter === "error" && p.status !== "failed") return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q);
    });
  }, [packs, query, statusFilter]);

  const selectedPack = packs.find((p) => p.id === selectedId) ?? null;
  const ready = packs.filter((p) => p.status === "ready").length;
  const failed = packs.filter((p) => p.status === "failed").length;
  const installing = packs.filter(
    (p) => p.status === "installing" || p.status === "syncing" || p.status === "pending",
  ).length;

  function statusCount(key: string): number {
    if (key === "all") return packs.length;
    if (key === "ready") return ready;
    if (key === "syncing") return installing;
    return failed;
  }

  const statusTabs = [
    { key: "all", label: "All" },
    { key: "ready", label: "Ready" },
    { key: "syncing", label: "Syncing" },
    { key: "error", label: "Error" },
  ].map((t) => ({ ...t, count: statusCount(t.key) }));

  return (
    <Page>
      <PageHeader
        breadcrumb="Team / Capabilities / Knowledge"
        title="Knowledge"
        pill={
          packs.length > 0 ? (
            <StatusPill tone="success">
              {ready}/{packs.length} ready
            </StatusPill>
          ) : undefined
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => void refetch()}>
              <RefreshCw className="size-3.5" />
              Refresh
            </Button>
            <Button onClick={() => setShowInstall(true)}>
              <BookOpen className="size-4" />
              Install Pack
            </Button>
          </>
        }
      />
      <p className="px-2 text-xs text-(--mute) md:px-0">
        Shared knowledge packs, attached per agent from the agent&apos;s Knowledge tab.
      </p>
      <PageBody>
        <div className="space-y-6">
          <InfoBanner
            id="ib:knowledge-help"
            title="How this page works"
            body="Packs are installed from a git repo or the builtin library, then referenced by agents. Example: https://github.com/org/repo.git or a local path."
          />

          <div data-testid="stat-cards" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <KpiTile label="Packs" value={packs.length} icon={BookOpenIcon} detail="installed" />
            <KpiTile
              label="Ready"
              value={ready}
              icon={CircleCheck}
              detail={`${installing} in flight`}
              bar={packs.length === 0 ? 0 : (ready / packs.length) * 100}
              barTone="ok"
            />
            <KpiTile
              label="Failed"
              value={failed}
              icon={CircleAlert}
              detail={failed > 0 ? "needs attention" : "clean"}
              bar={failed > 0 ? 100 : 0}
              barTone="err"
            />
            <KpiTile
              label="Installing"
              value={installing}
              icon={Download}
              detail="pending · syncing"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {statusTabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setStatusFilter(t.key)}
                className={`rounded px-2 py-0.5 font-mono text-[11px] transition-colors ${
                  statusFilter === t.key
                    ? "bg-(--panel2) font-medium text-(--primary)"
                    : "bg-(--canvas-soft) text-(--mute) hover:text-(--ink)"
                }`}
              >
                {t.label} ({t.count})
              </button>
            ))}
          </div>

          <ListToolbar
            searchValue={query}
            onSearch={setQuery}
            placeholder="Search packs by name or description"
          />

          <div>
            <SectionKicker hint="Installed packs are available to every agent.">
              Installed packs
            </SectionKicker>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((p) => {
                const usedByNames = (agentsData ?? [])
                  .filter((a) => a.knowledgePacks?.includes(p.id))
                  .map((a) => a.name);
                const isAssigned = (agentId: string) =>
                  Boolean(
                    (agentsData ?? [])
                      .find((ag) => ag.id === agentId)
                      ?.knowledgePacks?.includes(p.id),
                  );
                const onAssign = (agentId: string) => {
                  const agent = (agentsData ?? []).find((ag) => ag.id === agentId);
                  const next = [...(agent?.knowledgePacks ?? []), p.id];
                  void api.updateAgent(agentId, { knowledgePacks: next });
                  void qc.invalidateQueries({ queryKey: agentKeys.lists() });
                };
                const iconTone =
                  p.sourceKind === "builtin" ? "var(--primary)" : "var(--accent-violet)";
                return (
                  <div
                    key={p.id}
                    className="group relative flex flex-col justify-between rounded-lg border border-(--hairline) bg-(--panel) p-4 transition-colors hover:bg-(--canvas-soft)"
                  >
                    <div className="flex flex-col gap-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span
                            className="flex size-10 shrink-0 items-center justify-center rounded"
                            style={{
                              backgroundColor: `color-mix(in srgb, ${iconTone} 10%, transparent)`,
                              color: iconTone,
                            }}
                          >
                            <BookOpen className="size-5" />
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-display text-sm font-semibold text-(--ink-strong)">
                                {p.name}
                              </span>
                              {p.sourceRev && (
                                <span className="shrink-0 font-mono text-[10px] text-(--faint)">
                                  @{p.sourceRev.slice(0, 8)}
                                </span>
                              )}
                            </div>
                            <MonoLabel className="text-(--ok)">
                              {p.sourceKind} · {statusLabel(p.status)}
                            </MonoLabel>
                          </div>
                        </div>
                        <StatusPill tone={packTone(p.status)} className="shrink-0">
                          {statusLabel(p.status)}
                        </StatusPill>
                      </div>
                      <p className="line-clamp-2 text-xs text-(--mute)">
                        {(p.status === "failed" && p.error) || p.description || "No description."}
                      </p>
                      {(() => {
                        const st = allStats[p.id];
                        if (!st) return null;
                        return (
                          <div className="flex items-center gap-1.5 font-mono text-[10px] text-(--faint)">
                            {st.files} files · {Math.round(st.totalBytes / 1024)}KB indexed
                          </div>
                        );
                      })()}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <MonoLabel className="text-(--faint)">Bound agents:</MonoLabel>
                        {usedByNames.length > 0 ? (
                          usedByNames.slice(0, 3).map((name) => (
                            <span
                              key={name}
                              className="rounded bg-(--canvas-soft) px-1.5 py-0.5 font-mono text-[10px] text-(--accent-violet)"
                            >
                              {name}
                            </span>
                          ))
                        ) : (
                          <span className="font-mono text-[10px] text-(--warn)">not assigned</span>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-(--hairline) pt-2.5">
                      <span className="font-mono text-[10px] text-(--faint)">
                        {formatDate(p.createdAt)}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <AssignToAgentSelect
                          agents={agentsData ?? []}
                          assigned={isAssigned}
                          onAssign={onAssign}
                        />
                        <Button variant="outline" size="sm" onClick={() => setSelectedId(p.id)}>
                          Inspect
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-(--err) hover:bg-(--err)/10"
                          aria-label={`Delete ${p.name}`}
                          onClick={() => setConfirmPackId(p.id)}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div data-testid="empty-state" className="col-span-full">
                  <EmptyState
                    icon={BookOpen}
                    title="No knowledge packs installed"
                    description="Install your first pack with the Install Pack button above."
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </PageBody>

      <Dialog open={showInstall} onOpenChange={setShowInstall}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Install Knowledge Pack</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-docs-pack"
              />
            </div>
            <div className="space-y-1">
              <Label>Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="what it covers"
                rows={2}
              />
            </div>
            <div className="space-y-1">
              <Label>Source</Label>
              <select
                className="h-9 rounded border border-(--hairline) bg-transparent px-2"
                value={sourceKind}
                onChange={(e) => setSourceKind(e.target.value as "builtin" | "git")}
              >
                <option value="git">git</option>
                <option value="builtin">builtin</option>
              </select>
            </div>
            {sourceKind === "git" && (
              <div className="space-y-1">
                <Label>Repo URL</Label>
                <Input
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  placeholder="e.g. https://github.com/org/repo.git or a local path"
                />
              </div>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setShowInstall(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => void install.mutate()}
                disabled={install.isPending || !name || (sourceKind === "git" && !sourceUrl)}
              >
                {install.isPending ? "Installing…" : "Install"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {selectedPack && (
        <KnowledgeDetailSheet
          pack={selectedPack}
          usedBy={(agentsData ?? [])
            .filter((a) => a.knowledgePacks?.includes(selectedPack.id))
            .map((a) => a.name)}
          agents={agentsData ?? []}
          isAssigned={(agentId) =>
            Boolean(
              (agentsData ?? [])
                .find((ag) => ag.id === agentId)
                ?.knowledgePacks?.includes(selectedPack.id),
            )
          }
          onAssign={(agentId) => {
            const agent = (agentsData ?? []).find((ag) => ag.id === agentId);
            const next = [...(agent?.knowledgePacks ?? []), selectedPack.id];
            void api.updateAgent(agentId, { knowledgePacks: next });
            void qc.invalidateQueries({ queryKey: agentKeys.lists() });
          }}
          onClose={() => setSelectedId(null)}
        />
      )}

      <Dialog
        open={confirmPackId !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmPackId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete knowledge pack {confirmPackId}?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmPackId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmPackId) void remove.mutate(confirmPackId);
                setConfirmPackId(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
